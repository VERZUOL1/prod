const _ = require('lodash');
const PlannedStudyCountry = require('../../../db_platform/models').planned_study_country;
const Country = require('../../../db_platform/models').country;
const Region = require('../../../db_platform/models').region;
const Study = require('../../../db_ui/models').study;
const Scenario = require('../../../db_ui/models').scenario;
const { getStudyWithFullDetails } = require('./study_table');
const { getActualsData, getActualValuesForScenario } = require('../helpers/actuals');
const { getMinMaxDates } = require('../helpers/actuals');
const log = require('../../../utils/logger');
/**
 * Fetch impact scenario
 * @param id
 * @returns Object
 */
async function getImpactScenarioById(id) {
  try {
    const study = await Study.find({ where: { id } });

    if (!study) {
      const error = new Error(`Study ${id} not found.`);
      error.status = 404;
      throw error;
    }

    let foundStudy = study.get({ plain: true });

    let pStudy = null;
    if (foundStudy.is_imported === true) {
      pStudy = await getStudyWithFullDetails(foundStudy.study_id, { raw: true });
      if (pStudy) {
        const count = await Scenario.count({ where: { study_id: foundStudy.study_id } });
        /**
         * If study doesn't have any scenarios we update its parameters with latest ones that came from Impact
         * Once we create first scenario study will be updated with its own set
         */
        if (!count) {
          foundStudy = {
            ...foundStudy,
            target_lpft: pStudy.target_lpft,
            fp: pStudy.fp,
            target_num_patients: pStudy.target_num_patients,
            indication: pStudy['indication.name'],
            therapeutic_area: pStudy['indication.therapeutic_area.name'],
            fpfv_fpft: foundStudy.fpfv_fpft
          };
        }
      } else {
        log.error(`Impact information for study is absent: ${foundStudy.study_id}`);
      }
    }

    const scenario = {
      name: 'IMPACT plan',
      status: 'APPROVED',
      isImpact: true,
      events: [],
      cohorts: [],
      study_id: +id,
      is_archived: false,
      source_scenario_id: null,
      last_optimisation_date: null,
      adjusted_createdAt: null,
      owner_name: '-',
      end_date: foundStudy.target_lpft,
      target_num_patients: foundStudy.target_num_patients,
      fp: foundStudy.fp,
      fpfv_fpft: foundStudy.fpfv_fpft,
      state: {}
    };

    const predicate = {
      where: {
        study_id: foundStudy.study_id,
        country_id: { $not: null },
        num_patients: { $not: null }
      },
      attributes:
        [['num_patients', 'patient_allocation'],
          'country_id',
          'num_sites',
          'fsiv',
          'fpfv',
          'lpft'],
      include: [{
        model: Country,
        include: Region
      }]
    };
    // Fetch planned study countries
    const countries = await PlannedStudyCountry.findAll(predicate)
      .filter(item => item.country && item.country.region);
    // if no countries then impact is not found
    if (countries.length === 0) {
      const error = new Error(`Impact scenario for study ${id} not found.`);
      error.status = 404;
      throw error;
    }
    // create array of region ids
    const regionIds = _.uniq(countries.map(item => item.country.get('region_id')));

    const regionsData = await Region.findAll({
      where: {
        id: { $in: regionIds }
      },
      include: [{
        model: Country,
        attributes: ['id']
      }]
    });

    const platformRegions = regionsData.map(item => {
      const plainItem = item.get();
      return {
        id: plainItem.id,
        name: plainItem.name,
        hasSingleCountry: plainItem.countries.length === 1
      };
    });

    // Fetch actuals data
    let actualsTimeseries;
    let actualsParameters;
    let fp;
    let latestActuals;
    const data = await getActualValuesForScenario(foundStudy.study_id);
    // eslint-disable-next-line
    ({ actualsTimeseries, actualsParameters, fp, latestActuals } = data);

    scenario.countries = countries.map(country => {
      const plainItem = country.get({ plain: true });
      const countryRegion = _.find(platformRegions, region => region.name && plainItem.country.region.name
        && region.name.toLowerCase() === plainItem.country.region.name.toLowerCase());
      const region = {
        region_id: plainItem.country.region.id,
        region_name: plainItem.country.region.name,
        regionHasSingleCountry: (countryRegion && countryRegion.hasSingleCountry) || false
      };

      // Put actuals data
      const actuals = getActualsData(
        actualsParameters,
        actualsTimeseries,
        plainItem.country_id,
        fp || study.fp,
        latestActuals,
        getMinMaxDates(actualsTimeseries, latestActuals)
      );

      return {
        ..._.omit(plainItem, 'country'),
        ...region,
        ...actuals,
        overrideList: [],
        isImpact: true,
        country_name: plainItem.country.name,
        platform_country_id: plainItem.country_id
      };
    });
    return scenario;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  table: PlannedStudyCountry,
  getImpactScenarioById,
  findById: (id, options = {}) => PlannedStudyCountry.findById(id, options),
  findByStudyId: (study_id, options = {}) => PlannedStudyCountry.findAll({ where: { study_id }, ...options })
};
