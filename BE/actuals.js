const _ = require('lodash');
const { sortByDateAscending, getMomentDate, sortAscending } = require('./common');
const { isTableExist } = require('../helpers/common');
const PlatformStudy = require('../platform_db_API/study_table');
const ParameterActuals = require('../platform_db_API/parameter_actuals_table');
const TimeseriesActuals = require('../platform_db_API/timeseries_actuals_table.js');
const LatestActuals = require('../platform_db_API/latest_actuals');

/**
 * Prepare actuals object
 * @returns {{}}
 */
function getActualsData(actualsParameters, actualsTimeseries, countryId, fp, latestActuals, minMax) {
  let actuals = {};
  let countryLatestActuals = {};
  const parameters = actualsParameters.find(element => element.country_id === countryId);
  if (parameters) {
    actuals = {
      actual_fsiv: parameters.fp_fsiv ? getMomentDate(fp)
        .add(parameters.fp_fsiv, 'd')
        .format('YYYY-MM-DD') : null,
      actual_25_si: parameters.si_25 ? getMomentDate(fp)
        .add(parameters.si_25, 'd')
        .format('YYYY-MM-DD') : null,
      actual_50_si: parameters.si_50 ? getMomentDate(fp)
        .add(parameters.si_50, 'd')
        .format('YYYY-MM-DD') : null,
      actual_90_si: parameters.si_90 ? getMomentDate(fp)
        .add(parameters.si_90, 'd')
        .format('YYYY-MM-DD') : null,
      actual_sas: parameters.sas,
      actual_fpfv_lpfv: parameters.fpfv_lpfv,
      actual_randomization_rate: parameters.randomization_rate,
      actual_screening_failure: parameters.screening_failure,
      actual_screening_rate: parameters.screening_rate,
      actual_f_lpft: parameters.f_lpft,
      actual_overallocation: parameters.overallocation,
      original_f_lpft: parameters.original_f_lpft
    };
  }

  let timeSeries = actualsTimeseries.filter(element => element.country_id === countryId);
  timeSeries = timeSeries.map(item => {
    const date = getMomentDate(item.date);
    return {
      ...item,
      formattedDate: date.format('YYYY-MM-DD'),
      date
    };
  })
    .sort(sortByDateAscending);
  const lastActualElement = _.findLast(timeSeries, element => element.type === 'ACTUALS');
  const timeSeriesLatestActualDate = _.get(lastActualElement, 'date');
  countryLatestActuals = latestActuals.find(item => item.country_id === countryId);

  if (countryLatestActuals && lastActualElement) {
    const siteInitiated = countryLatestActuals.sites_initiated;
    const patientsScreened = countryLatestActuals.patients_screened;
    const patientsRandomized = countryLatestActuals.patients_randomized;
    const latestActualsDate = _.get(countryLatestActuals, 'latest_date');
    if (latestActualsDate && latestActualsDate.isValid()
      && latestActualsDate.isSameOrAfter(getMomentDate(timeSeriesLatestActualDate), 'day')
      && !_.isNil(siteInitiated) && siteInitiated >= lastActualElement.sites_initiated
      && !_.isNil(patientsScreened) && patientsScreened >= lastActualElement.patients_screened
      && !_.isNil(patientsRandomized) && patientsRandomized >= lastActualElement.patients_randomized) {
      timeSeries.push({
        study_id: countryLatestActuals.study_id,
        country_id: countryLatestActuals.country_id,
        formattedDate: latestActualsDate.format('YYYY-MM-DD'),
        date: latestActualsDate.clone(),
        cohort_name: null,
        sites_initiated: countryLatestActuals.sites_initiated,
        patients_screened: countryLatestActuals.patients_screened,
        patients_randomized: countryLatestActuals.patients_randomized,
        type: 'ACTUALS',
        q75_patients_randomized: null,
        q25_patients_randomized: null,
        sites_enrolling: countryLatestActuals.sites_enrolling
      });
    }
  }

  // Transform timeSeries to object
  const timeSeriesObj = timeSeries.reduce((res, item) => {
    res[item.formattedDate] = item;
    return res;
  }, {});

  timeSeries = timeSeries.sort(sortByDateAscending);

  if (timeSeries && timeSeries.length > 0) {
    // prepare reference array
    let currentDate = minMax.min;
    const referenceArr = [];
    while (currentDate <= minMax.max) {
      referenceArr.push(currentDate);
      currentDate = currentDate.clone()
        .add(1, 'd');
    }

    const actual_siv = [];
    const actual_screened = [];
    const actual_randomized = [];
    const q75_actual_randomized = [];
    const q25_actual_randomized = [];

    let actual_date = null;
    let actual_num_sites = null;
    let actual_sites_enrolling = null;
    let actual_patient_allocation = null;

    let prevElement = {
      actual_date: null,
      sites_initiated: 0,
      patients_screened: 0,
      patients_randomized: 0,
      type: 'FORECAST'
    };

    referenceArr.forEach(date => {
      const formattedDate = date.format('YYYY-MM-DD');
      const element = timeSeriesObj[formattedDate];
      if (element) {
        actual_siv.push([formattedDate, element.sites_initiated, element.type]);
        actual_screened.push([formattedDate, element.patients_screened, element.type]);
        actual_randomized.push([formattedDate, element.patients_randomized, element.type]);
        q75_actual_randomized.push([formattedDate, element.q75_patients_randomized, element.type]);
        q25_actual_randomized.push([formattedDate, element.q25_patients_randomized, element.type]);
        if (element.type === 'ACTUALS') {
          actual_date = formattedDate;
          actual_num_sites = element.sites_initiated;
          actual_sites_enrolling = element.sites_enrolling;
          actual_patient_allocation = element.patients_randomized;
        }
        prevElement = element;
      } else if (prevElement) {
        actual_siv.push([formattedDate, prevElement.sites_initiated, prevElement.type]);
        actual_screened.push([formattedDate, prevElement.patients_screened, prevElement.type]);
        actual_randomized.push([formattedDate, prevElement.patients_randomized, prevElement.type]);
        q75_actual_randomized.push([formattedDate, prevElement.q75_patients_randomized, prevElement.type]);
        q25_actual_randomized.push([formattedDate, prevElement.q25_patients_randomized, prevElement.type]);
      }
    });
    if (actual_siv.length > 0 && actual_screened.length > 0 && actual_randomized.length > 0) {
      actuals = {
        ...actuals,
        actual_date,
        actual_siv,
        actual_screened,
        actual_randomized,
        q75_actual_randomized,
        q25_actual_randomized,
        actual_num_sites,
        actual_patient_allocation,
        actual_sites_enrolling
      };
    }
  }

  return actuals;
}

/**
 * Collect actual data for scenario
 * @param countriesIds
 * @param studyId
 * @returns {{actualsTimeseries: Array, actualsParameters: Array}}
 */
async function getActualValuesForScenario(studyId) {
  let actualsTimeseries = [];
  let actualsParameters = [];
  let latestActuals = [];
  const platformStudy = await PlatformStudy.findByStudyId(studyId);
  const actualsTimeseriesTableExists = isTableExist('study_country_timeseries_actuals');
  const actualsParametersTableExists = isTableExist('study_country_parameter_actuals');
  const latestActualsTableExists = isTableExist('study_country_latest_actuals');
  if (
    platformStudy
    && (platformStudy.get('status') === 'ACTIVE' || platformStudy.get('status') === 'COMPLETED')
    && actualsParametersTableExists
    && actualsTimeseriesTableExists) {
    const actualsTimeseriesData = await TimeseriesActuals
      .getActualsByStudyId(studyId);
    actualsTimeseries = actualsTimeseriesData.map(item => item.get({ plain: true }));

    const actualsParametersData = await ParameterActuals
      .getActualsByStudyId(studyId);
    actualsParameters = actualsParametersData.map(item => item.get({ plain: true }));
  }

  if (latestActualsTableExists) {
    const latestActualsData = await LatestActuals.getLatestActualsByStudyId(studyId);
    latestActuals = latestActualsData.reduce((res, item) => {
      const plainItem = item.get({ plain: true });
      const date = getMomentDate(plainItem.latest_date);
      if (date && date.isValid() && plainItem.country_id) {
        res.push({
          ...plainItem,
          latest_date: date
        });
      }

      return res;
    }, []);
  }

  return {
    actualsTimeseries, actualsParameters, fp: platformStudy && platformStudy.get('fp'), latestActuals
  };
}

/**
 * Gets min and max dates from timeseries
 * @param actualsTimeseries
 * @param latestActuals
 * @returns {{min: T, max: T}}
 */
function getMinMaxDates(actualsTimeseries, latestActuals) {
  const timeseriesDates = [
    ...actualsTimeseries.map(item => getMomentDate(item.date)),
    ...latestActuals.map(item => getMomentDate(item.latest_date))
  ]
    .sort(sortAscending);
  return { min: timeseriesDates[0], max: timeseriesDates[timeseriesDates.length - 1] };
}

module.exports = {
  getActualsData,
  getActualValuesForScenario,
  getMinMaxDates
};
