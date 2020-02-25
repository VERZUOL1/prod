const lodash = require('lodash');
const log = require('../../../utils/logger');
const CohortsTable = require('./cohorts_table');
const RegionsTable = require('./regions_table');
const CountryTable = require('./country_table');
const OverrideTable = require('./override_table');
const PlatformStudy = require('../platform_db_API/study_table');

const { isTableExist } = require('../helpers/common');
const ParameterActuals = require('../platform_db_API/parameter_actuals_table');
const TimeseriesActuals = require('../platform_db_API/timeseries_actuals_table.js');

const UIParameterPredictionsTable = require('./parameter_prediction_table');
const PlatformParameterPredictionsTable = require('../platform_db_API/').parameterPredictionTable;


/**
 * Convert Overrides table fields names to prediction fields names
 * @param fieldName
 * @returns {*}
 */
function overrideToPublishedParametersFieldsConverted(fieldName) {
  switch (fieldName) {
    case '25_si':
      return 'si_25';
    case '50_si':
      return 'si_50';
    case '90_si':
      return 'si_90';
    case 'patient_allocation':
      return 'num_patients';
    default:
      return fieldName;
  }
}

/**
 * Recursive function to create cohorts which depends on not existing yet cohorts in DB
 * @param fullCohortList
 * @param majorCohortIds
 * @param newCohorts
 * @returns {*}
 */
async function createCohorts(fullCohortList, opt = {}) {
  const { majorCohortIds = [null], newCohorts = [], options = {} } = opt;
  const cohortsToCreate = fullCohortList.filter(ch => majorCohortIds.includes(ch.trigger.source_cohort_id));
  if (cohortsToCreate.length === 0) {
    return newCohorts;
  }
  try {
    const createdCohorts = await Promise.all(cohortsToCreate.map(ctc => {
      const source_cohort = newCohorts.find(nc => nc.old_id === ctc.trigger.source_cohort_id);
      return CohortsTable.table.create({
        name: ctc.name,
        rank: ctc.rank,
        adjust_source_cohort_id: ctc.adjust_source_cohort_id,
        scenario_id: ctc.scenario_id,
        ...ctc.trigger,
        source_cohort_id: source_cohort ? source_cohort.id : ctc.trigger.source_cohort_id
      }, options)
        .then(nCohort => {
          const newCohort = nCohort.get({ plain: true });
          newCohort.old_id = ctc.id;
          newCohort.locations = ctc.locations;
          return newCohort;
        })
        .catch(e => {
          throw (e);
        });
    }));
    const newOpt = {
      majorCohortIds: createdCohorts.map(cc => cc.old_id),
      newCohorts: [...newCohorts, ...createdCohorts],
      options
    };
    return createCohorts(fullCohortList, newOpt);
  } catch (e) {
    throw e;
  }
}

/**
 * Create regions
 */
function createRegionsHelper(regions, options = {}) {
  return Promise.all(regions.map(cl =>
    RegionsTable.createRegion(cl.name, options)
      .spread(region =>
        cl.countries.map(oldCountry =>
          [oldCountry.id, oldCountry.name, region.id, cl.id]))));
}

/**
 * moved to the country table
 * Create countries
 */
function createCountriesHelper(countries, options = {}) {
  return Promise.all(countries.map(c => CountryTable.createCountry(...c.slice(0, 3), options)
    .spread(country => ({ ...country.get({ plain: true }), platformRegionId: c[3] }))));
}

/**
 * Create override and country pair related to the scenario or cohort
 */
function createOverridesDataHelper(idObj, countriesData, locationsArray, options = {}) {
  return Promise.all(countriesData.map(country => {
    let newLocationData;
    if (country.name === 'Unspecified country') {
      newLocationData = locationsArray.find(item => item.region_id === country.platformRegionId
      && item.name === 'Unspecified country');
    } else {
      newLocationData = locationsArray.find(item => item.platform_country_id === country.platform_country_id);
    }
    const otherFields = lodash.pick(
      newLocationData,
      [
        'fsiv',
        'sas',
        '25_si',
        '50_si',
        '90_si',
        'fpfv',
        'sr',
        'screening_failure',
        'randomisation_rate',
        'lpft'
      ]
    );

    return OverrideTable.create({
      ...idObj,
      country_id: country.id,
      constraint: newLocationData.constraint,
      patient_allocation: newLocationData.patients || newLocationData.patient_allocation || null,
      patient_allocation_min: newLocationData.patients_min || null,
      patient_allocation_max: newLocationData.patients_max || null,
      num_sites: newLocationData.sites || newLocationData.num_sites || null,
      ...otherFields
    }, options);
  }));
}

/**
 * Collect actual data for cohort
 * @param countriesIds
 * @param cohortName
 * @param studyId
 * @returns {{actualsTimeseries: Array, actualsParameters: Array}}
 */
async function getActualValuesForCohort(countriesIds, cohortName, studyId) {
  let actualsTimeseries = [];
  let actualsParameters = [];
  const platformStudy = await PlatformStudy.findByStudyId(studyId);
  const actualsTimeseriesTableExists = isTableExist('study_country_timeseries_actuals');
  const actualsParametersTableExists = isTableExist('study_country_parameter_actuals');
  if (
    platformStudy
    && (platformStudy.get('status') === 'ACTIVE' || platformStudy.get('status') === 'COMPLETED')
    && actualsParametersTableExists
    && actualsTimeseriesTableExists) {
    const actualsTimeseriesData = await TimeseriesActuals
      .getActualsByCountriesIdsStudyIdCohortName(countriesIds, platformStudy.study_id, cohortName);
    actualsTimeseries = actualsTimeseriesData.map(item => item.get({ plain: true }));

    const actualsParametersData = await ParameterActuals
      .getActualsByCountriesIdsStudyIdCohortName(countriesIds, platformStudy.study_id, cohortName);
    actualsParameters = actualsParametersData.map(item => item.get({ plain: true }));
  }
  return {
    actualsTimeseries, actualsParameters, fp: platformStudy && platformStudy.get('fp'), latestActuals: []
  };
}

/**
 *
 * @param rawOverride
 * @param predicted
 */
function mergeOverrideWithPrediction(rawOverride, predicted) {
  const override = lodash.omit(rawOverride, 'country');
  // merge override with predicted
  const overrideList = [];
  // if predicted row exists
  if (predicted) {
    const predictedObj = lodash.omit(predicted.get({ plain: true }), ['id']);
    // map empty overrides list by predicted values
    if (predictedObj.fp_fsiv !== null && predictedObj.fsiv_fpfv !== null) {
      predictedObj.fpfv = predictedObj.fp_fsiv + predictedObj.fsiv_fpfv;
    }
    if (predictedObj.fp_fsiv) {
      predictedObj.fsiv = predictedObj.fp_fsiv;
    }
    Object.keys(override)
      .forEach(curr => {
        if (override[curr] === null) {
          override[curr] = predictedObj[overrideToPublishedParametersFieldsConverted(curr)];
        } else {
          overrideList.push(curr);
        }
      });
  } else {
    // fill overrode list
    Object.keys(override)
      .forEach(curr => {
        if (override[curr] !== null) {
          overrideList.push(curr);
        }
      });
  }

  // updateOverrideShiftsWithDates(override, study.fp);

  override.override_id = rawOverride.id;
  override.overrideList = overrideList;
  return override;
}

/**
 * For merging adjusted snapshot of scenarion and user oberrides
 * @param rawOverride
 * @param snapshot
 */
function mergeOverrideWithSnapshot(overridePlain, snapshot) {
  const overrideList = [];
  let platform_country_id = null;
  if (overridePlain.country_name !== 'Unspecified country') {
    platform_country_id = overridePlain.platform_country_id || overridePlain.country.platform_country_id;
  }
  const adjustedOverride = {
    ...overridePlain.country,
    country_id: overridePlain.country_id || overridePlain.country.id,
    platform_country_id,
    country_name: overridePlain.country_name || overridePlain.country.name,
    region_id: overridePlain.region_id || overridePlain.country.region.id,
    region_name: overridePlain.region_name || overridePlain.country.region.name,
    regionHasSingleCountry: overridePlain.regionHasSingleCountry === null
    || overridePlain.regionHasSingleCountry === undefined
      ? overridePlain.country.region.hasSingleCountry : overridePlain.regionHasSingleCountry
  };
  // lets store applied actual values in this array
  const appliedActualsList = [];
  if (snapshot) {
    Object.keys(overridePlain)
      .forEach(key => {
        if (overridePlain[key] === null && key !== 'constraint') {
          // eslint-disable-next-line
          overridePlain[key] = snapshot[key];
          // push applied field name
          appliedActualsList.push(key);
          // do not include some fields to overrode fields
        } else if (!(['id', 'scenario_id', 'country_id', 'country', 'constraint'].includes(key))) {
          overrideList.push(key);
        }
      });
  } else {
    Object.keys(overridePlain)
      .forEach(key => {
        if (overridePlain[key] && !(['id', 'scenario_id', 'country_id', 'country', 'constraint'].includes(key))) {
          overrideList.push(key);
        }
      });
  }
  const actualTimeseriesSnapshot = {};
  if (snapshot) {
    actualTimeseriesSnapshot.actual_date = snapshot.actual_date;
    actualTimeseriesSnapshot.sites_initiated = snapshot.sites_initiated;
    actualTimeseriesSnapshot.patients_screened = snapshot.patients_screened;
    actualTimeseriesSnapshot.patients_randomized = snapshot.patients_randomized;
  }
  return lodash.omit({
    ...adjustedOverride,
    ...overridePlain,
    overrideList,
    override_id: overridePlain.id,
    actualTimeseriesSnapshot
  }, ['country']);
}
/**
 * Collect predictions for scenario countries and count all predicted countries
 * @param countriesIds
 * @param scenarioId
 */
async function getScenarioPredictionParameters(countriesIds, scenario_id) {
  try {
    const tableExist = await isTableExist('parameter_prediction');
    let predictedCountries = [];
    let predictionsByCountries = [];
    if (tableExist) {
      predictedCountries = await PlatformParameterPredictionsTable.table.findAndCountAll({
        where: {
          scenario_id
        }
      });
      predictionsByCountries = await UIParameterPredictionsTable
        .findByCountryIdAndScenarioId(countriesIds, scenario_id);
      if (predictionsByCountries.length === 0 && predictedCountries && predictedCountries.rows) {
        predictionsByCountries
          = predictedCountries.rows.filter(predCountry => countriesIds.includes(predCountry.country_id));
      }
    }
    return {
      predictedCountries: {
        ...predictedCountries,
        rows: predictedCountries && predictedCountries.rows
          ? predictedCountries.rows.map(pred => ({ country_id: pred.country_id })) : []
      },
      predictionsByCountries
    };
  } catch (e) {
    log.error(`getScenarioPredictionParameters, scenario id is ${scenario_id}`);
    throw e;
  }
}

module.exports = {
  createCohorts,
  createRegionsHelper,
  createCountriesHelper,
  createOverridesDataHelper,
  getActualValuesForCohort,
  overrideToPublishedParametersFieldsConverted,
  mergeOverrideWithPrediction,
  mergeOverrideWithSnapshot,
  getScenarioPredictionParameters
};
