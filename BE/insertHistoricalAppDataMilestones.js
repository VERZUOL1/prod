const lodash = require('lodash');
const moment = require('moment');

const log = require('../../../../utils/logger');
const { chunkArray } = require('../../../../utils/fileUtils');
const {
  FpoApprovedPlanMilestones,
  FpoApprovedPlanCurves,
  FpoApprovedPlanCurvesDaily,
  NLStudyEvent,
  NLStudyRegionEvent,
  NLStudyCountryEvent,
  NLStudy,
  NLStudyRegion,
  NLStudyCountry,
  NLStudySiteIniPlan,
  NLStudyCntrySiteIniPln,
  NLStudyRegionSiteIninPln,
  NLSTtudySubjFigAll,
  NLStudyCtrySubjFigAll,
  NLStudyRegionSubjFigAll
} = require('../../../db_interface/ui_db_API/index');
const IntegrationCurvesDTO = require('../integrationCurvesDTO');

const milestonesToNLStudyEvent = require('../milestonesEventsIntegtarionData/milestonesToNLStudyEvents');
const milestonesToNLStudyRegionEvents = require('../milestonesEventsIntegtarionData/milestonesToNLStudyRegionEvents');
const milestonesToNLStudyCountryEvents = require('../milestonesEventsIntegtarionData/milestonesToNLStudyCountryEvents');

const milestonesToNLStudy = require('../milestonesMetricsIntegrationData/milestonesToNLStudy');
const milestonesToNLStudyRegion = require('../milestonesMetricsIntegrationData/milestonesToNLStudyRegion');
const milestonesToNLStudyCountry = require('../milestonesMetricsIntegrationData/milestonesToNLStudyCountry');

const curvesToNL_STUDY_SITE_INI_PLAN = require('../randAndScreenCurvesIntegrationData/curvesToNL_STUDY_SITE_INI_PLAN');
const curvesToNL_STUDY_CNTRY_SITE_INI_PLN
  = require('../randAndScreenCurvesIntegrationData/curvesToNL_STUDY_CNTRY_SITE_INI_PLN');
const curvesToNL_STUDY_REGION_SITE_INI_PLN
  = require('../randAndScreenCurvesIntegrationData/curvesToNL_NL_STUDY_REGION_SITE_INI_PLN');

const curvesToNL_STUDY_SUBJ_FIG_ALL
  = require('../randAndScreenCurvesIntegrationData/curvesToNL_STUDY_SUBJ_FIG_ALL');
const curvesToNL_STUDY_CTRY_SUBJ_FIG_ALL
  = require('../randAndScreenCurvesIntegrationData/curvesToNL_STUDY_CTRY_SUBJ_FIG_ALL');
const curvesToNL_STUDY_REGION_SUBJ_FIG_ALL
  = require('../randAndScreenCurvesIntegrationData/curvesToNL_STUDY_REGION_SUBJ_FIG_ALL');

/**
 * Create moment date based on UTC
 * @param date
 * @returns {moment.Moment}
 */
function createMomentDate(date) {
  return moment.utc(date, ['YYYY-MM-DD', 'DD-MM-YYYY', 'DD MMM YYYY', moment.ISO_8601]);
}

/**
 * For dawnsampling
 * @param backDelta
 * @param dailyCollection
 */
function findPatientScreened(backDelta, dailyCollection, ps, sites) {
  let PS = ps || null;
  let SITES = sites || null;
  for (let i = dailyCollection.length; i >= (dailyCollection.length - backDelta); i -= 1) {
    if (dailyCollection[i - 1].NUM_PATIENTS_SCREENED !== null && PS === null) {
      PS = dailyCollection[i - 1].NUM_PATIENTS_SCREENED;
    }
    if (dailyCollection[i - 1].NUM_SITES !== null && SITES === null) {
      SITES = dailyCollection[i - 1].NUM_SITES;
    }
  }
  return [PS, SITES];
}

/**
 *
 * @param approvedData
 * @param SCENARIO_ID
 * @param TRIAL_ID
 * @param isAdjustedCopy
 * @param COHORT_NAME
 * @param transaction
 * @param withoutExtraTables
 * @param UPDATED - if we should set data different from today
 * @returns {Promise<*>}
 */
async function insertHistoricalApprovedDataMilestones(
  approvedData,
  SCENARIO_ID,
  isAdjustedCopy,
  TRIAL_ID,
  COHORT_NAME = null,
  transaction = null,
  UPDATED = null,
  withoutExtraTables
) {
  if (!approvedData.fp) {
    log.error(`INTEGRATION DATA CREATION: FP > ${approvedData.fp} < for scenario ${SCENARIO_ID} is not correct!`);
    throw new Error('FP not valid to save integration data');
  }

  const _SHIFT = approvedData.daily ? 'd' : 'w';
  const UPDATED_AT = moment()
    .format('YYYY-MM-DD HH:mm:ss');
  const fp = createMomentDate(approvedData.fp);
  const approvedFullData = approvedData.fullData;
  const curvesDataForSave = [];
  const weeklyCurvesForSave = [];
  const milestonesToSaveOverallocated = [];
  const milestonesToSave = Object.keys(approvedFullData)
    .map(country => {
      if (!approvedFullData[country].curves) {
        log.debug(approvedFullData[country]);
        log.error(`Update integration tables: one or more curves is empty for ${country}!`);
        throw (new Error('Missed one or more curves !'));
      }

      const milestones = lodash.omit(approvedFullData[country], ['curves']);
      const LPFT = createMomentDate(milestones.overallocatedData ? milestones.overallocatedData.lpft : milestones.lpft);
      const [numSites, screened, randomizedRaw] = approvedFullData[country].curves;
      if (!numSites || !screened || !randomizedRaw) {
        log.debug(approvedFullData[country].curves);
        log.error(`Update integration tables: one or more curves is empty for ${country}!`);
        throw (new Error('Missed one or more curves !'));
      }

      const randomizedValues = randomizedRaw.map(item => item[1]);
      const index = randomizedValues.indexOf(Math.max(...randomizedValues));
      const randomized = index > -1 ? randomizedRaw.slice(0, index + 1) : randomizedRaw;

      let lpfv = null;
      let lpfvDay = null;
      let ENTERED_TRIAL = null;
      if (milestones.lpfv) {
        lpfv = createMomentDate(milestones.lpfv);
        lpfvDay = lpfv.diff(fp, _SHIFT);
        const lpfvEl = screened.find(item => item[0] >= lpfvDay);
        ENTERED_TRIAL = lpfvEl ? Math.floor(lpfvEl[1]) : null;
      } else if (milestones.fpfv && milestones.fpfv_lpfv) {
        lpfv = createMomentDate(milestones.fpfv)
          .add(milestones.fpfv_lpfv, _SHIFT);
        lpfvDay = lpfv.diff(fp, _SHIFT);
        const lpfvEl = screened.find(item => item[0] >= lpfvDay);
        ENTERED_TRIAL = lpfvEl ? Math.floor(lpfvEl[1]) : null;
      }

      let ENTERED_TRIAL_over = null;
      let lastActualDate = null;
      if (isAdjustedCopy && approvedFullData[country].actualTimeseriesSnapshot) {
        // Last actual data date for country/region
        lastActualDate = approvedFullData[country].actualTimeseriesSnapshot.actual_date
          ? createMomentDate(approvedFullData[country].actualTimeseriesSnapshot.actual_date)
          : null;
      } else if (isAdjustedCopy && Array.isArray(withoutExtraTables)) {
        // ONLY FOR DATA MIGRATION 20190326-3-integration-update-tables
        if (country === '_Global Rollup') {
          lastActualDate = moment
            .max(withoutExtraTables.reduce((next, wet) => {
              // to do optimize - move up
              if (wet.actual_date) {
                next.push(wet.actual_date);
              }
              return next;
            }, []
            ));
        } else if (!approvedFullData[country].country_id) {
          lastActualDate = moment
            .max(withoutExtraTables.reduce((next, wet) => {
              // to do optimize - move up
              if (wet.actual_date && approvedFullData[country].region_id
                === wet['country.region_id']) {
                next.push(wet.actual_date);
              }
              return next;
            }, []
            ));
        } else {
          const cohortId = COHORT_NAME ? approvedData.id : null;
          const lastActual = withoutExtraTables
            .find(wet => wet.country_id === approvedFullData[country].country_id && wet.cohort_id === cohortId);
          if (lastActual) {
            lastActualDate = lastActual.actual_date ? lastActual.actual_date : null;
          }
        }
      }
      for (let shift = 0; shift <= randomized.length; shift += 1) {
        const reportedDate = fp.clone()
          .add(shift, _SHIFT);
        const numSiteGrains = numSites.filter(nsi => nsi[0] === shift);
        let screenedGrain = [];
        let randomizedGrain = [];
        let numSiteGrain = null;
        if (lastActualDate === null || lastActualDate.isSameOrBefore(reportedDate, 'day')) {
          // in case when reported date goes after LPFV (fpfv + fpfv_lpfv) this point will be cut
          if (reportedDate.isSameOrBefore(lpfv, 'd')) {
            screenedGrain = screened.find(si => si[0] === shift) || [];
          }
          randomizedGrain = randomized.find(ri => ri[0] === shift) || [];
          numSiteGrain = lodash.maxBy(numSiteGrains, grain => grain[1]);
        }
        if (milestones.overallocatedData) {
          if (reportedDate.isSame(LPFT, 'day')) {
            ENTERED_TRIAL_over = Math.floor(screenedGrain[1]) || null;
          }
        }
        // if (lpfv && reportedDate.isSame(lpfv, 'day')) {
        // ENTERED_TRIAL = Math.floor(screenedGrain[1]) || null;
        // }
        // if reported day is later then LPFT date we don't need this record in the integration table
        const LPFTDelta = reportedDate
          .diff(createMomentDate(milestones.lpft), 'days');
        if (LPFTDelta <= 0) {
          const curvePointDTO = new IntegrationCurvesDTO(
            shift,
            TRIAL_ID,
            SCENARIO_ID,
            milestones,
            COHORT_NAME,
            UPDATED || UPDATED_AT,
            fp,
            numSiteGrain || [],
            randomizedGrain,
            screenedGrain,
            _SHIFT
          );
          curvePointDTO.overallocation = false;
          if (milestones.overallocatedData) {
            const notOverLPFTDelta = reportedDate
              .diff(LPFT, 'days');
            if (notOverLPFTDelta > 0) {
              curvePointDTO.overallocation = true;
            }
          }
          if (approvedData.daily) {
            curvesDataForSave.push(curvePointDTO);
            // save dawnsampled values
            const prevItem = weeklyCurvesForSave[weeklyCurvesForSave.length - 1];
            if (LPFTDelta === 0) {
              const prevDate = createMomentDate(prevItem.DATE);
              const newDate = prevDate.clone()
                .add(1, 'w');
              const DTO = { ...curvePointDTO, DATE: newDate.format('YYYY-MM-DD') };
              if (DTO.NUM_PATIENTS_SCREENED === null || DTO.NUM_SITES) {
                let daysDelta = reportedDate
                  .diff(prevDate, 'days');
                if (curvesDataForSave.length < daysDelta) {
                  daysDelta = curvesDataForSave.length;
                }
                const [PS, NUM_SITES]
                  = findPatientScreened(daysDelta, curvesDataForSave, DTO.NUM_PATIENTS_SCREENED, DTO.NUM_SITES);
                DTO.NUM_PATIENTS_SCREENED = PS;
                DTO.NUM_SITES = NUM_SITES;
              }
              weeklyCurvesForSave.push(DTO);
            } else if (shift === 0 || (shift % 7 === 0)) {
              const DTO = { ...curvePointDTO };
              const needSearchRight = shift !== 0
                && (
                  (DTO.NUM_PATIENTS_SCREENED === null && prevItem.DATE.NUM_PATIENTS_SCREENED !== null)
                  || (DTO.NUM_SITES === null && prevItem.DATE.NUM_SITES !== null)
                );
              if (needSearchRight) {
                const [PS, NUM_SITES]
                  = findPatientScreened(6, curvesDataForSave, DTO.NUM_PATIENTS_SCREENED, DTO.NUM_SITES);
                DTO.NUM_PATIENTS_SCREENED = PS;
                DTO.NUM_SITES = NUM_SITES;
              }
              weeklyCurvesForSave.push(DTO);
            }
          } else {
            weeklyCurvesForSave.push(curvePointDTO);
          }
        }
      }
      if (milestones.overallocatedData) {
        milestonesToSaveOverallocated.push({
          SCENARIO_ID,
          REGION_NAME: milestones.region_name || null,
          COUNTRY_NAME: milestones.country_name || null,
          COHORT_NAME,
          TRIAL_ID,
          SI_25: milestones.overallocatedData['25_si'],
          SI_50: milestones.overallocatedData['50_si'],
          SI_90: milestones.overallocatedData['90_si'],
          FPFV: milestones.overallocatedData.fpfv,
          LPFT: milestones.overallocatedData.lpft,
          FPFT: milestones.fpft,
          FSIV: milestones.overallocatedData.fsiv,
          LPFV: milestones.overallocatedData.lpfv,
          NUM_SITES: milestones.overallocatedData.num_sites,
          PATIENT_ALLOCATION: approvedFullData[country].ignore_aggregation === true
            ? 0
            : milestones.overallocatedData.patient_allocation,
          RANDOMISATION_RATE: milestones.overallocatedData.randomisation_rate,
          SAS: milestones.overallocatedData.sas,
          SCREENING_FAILURE: milestones.overallocatedData.screening_failure,
          UPDATED_AT: UPDATED || UPDATED_AT,
          overallocation: false,
          ENTERED_TRIAL: ENTERED_TRIAL_over
        });
      }
      return {
        SCENARIO_ID,
        REGION_NAME: milestones.region_name || null,
        COUNTRY_NAME: milestones.country_name || null,
        COHORT_NAME,
        TRIAL_ID,
        SI_25: milestones['25_si'],
        SI_50: milestones['50_si'],
        SI_90: milestones['90_si'],
        FPFV: milestones.fpfv,
        LPFT: milestones.lpft,
        FPFT: milestones.fpft,
        FSIV: milestones.fsiv,
        LPFV: lpfv,
        NUM_SITES: milestones.num_sites,
        PATIENT_ALLOCATION: approvedFullData[country].ignore_aggregation === true ? 0 : milestones.patient_allocation,
        RANDOMISATION_RATE: milestones.randomisation_rate,
        SAS: milestones.sas,
        SCREENING_FAILURE: milestones.screening_failure,
        UPDATED_AT: UPDATED || UPDATED_AT,
        overallocation: Boolean(milestones.overallocatedData),
        ENTERED_TRIAL
      };
    });
  const options = { raw: true };
  if (transaction !== null) {
    options.transaction = transaction;
  }
  const NL_STUDY_EVENT = [];
  const NL_STUDY_COUNTRY_EVENT = [];
  const NL_STUDY_REGION_EVENT = [];

  const NL_STUDY = [];
  const NL_STUDY_COUNTRY = [];
  const NL_STUDY_REGION = [];

  const NL_STUDY_SITE_INI_PLAN = [];
  const NL_STUDY_CNTRY_SITE_INI_PLN = [];
  const NL_STUDY_REGION_SITE_INI_PLN = [];

  const NL_STUDY_SUBJ_FIG_ALL = [];
  const NL_STUDY_CTRY_SUBJ_FIG_ALL = [];
  const NL_STUDY_REGION_SUBJ_FIG_ALL = [];
  const storeInNLTables = !withoutExtraTables && COHORT_NAME === null;

  if (storeInNLTables) {
    [...milestonesToSave, ...milestonesToSaveOverallocated].forEach(mts => {
      if (!mts.REGION_NAME) {
        NL_STUDY_EVENT.push(...milestonesToNLStudyEvent(mts));
        NL_STUDY.push(milestonesToNLStudy(mts));
      } else if (!mts.COUNTRY_NAME) {
        NL_STUDY_REGION_EVENT.push(...milestonesToNLStudyRegionEvents(mts));
        NL_STUDY_REGION.push(milestonesToNLStudyRegion(mts));
      } else {
        NL_STUDY_COUNTRY_EVENT.push(...milestonesToNLStudyCountryEvents(mts));
        NL_STUDY_COUNTRY.push(milestonesToNLStudyCountry(mts));
      }
    });

    curvesDataForSave.forEach(curvePoint => {
      if (!curvePoint.REGION_NAME) {
        NL_STUDY_SITE_INI_PLAN.push(curvesToNL_STUDY_SITE_INI_PLAN(curvePoint));
        NL_STUDY_SUBJ_FIG_ALL.push(curvesToNL_STUDY_SUBJ_FIG_ALL(curvePoint));
      } else if (!curvePoint.COUNTRY_NAME) {
        NL_STUDY_REGION_SITE_INI_PLN.push(curvesToNL_STUDY_REGION_SITE_INI_PLN(curvePoint));
        NL_STUDY_REGION_SUBJ_FIG_ALL.push(curvesToNL_STUDY_REGION_SUBJ_FIG_ALL(curvePoint));
      } else {
        NL_STUDY_CNTRY_SITE_INI_PLN.push(curvesToNL_STUDY_CNTRY_SITE_INI_PLN(curvePoint));
        NL_STUDY_CTRY_SUBJ_FIG_ALL.push(curvesToNL_STUDY_CTRY_SUBJ_FIG_ALL(curvePoint));
      }
    });

    await Promise.all([
      ...chunkArray(NL_STUDY_EVENT, 5000)
        .map(item => NLStudyEvent.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_REGION_EVENT, 5000)
        .map(item => NLStudyRegionEvent.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_COUNTRY_EVENT, 5000)
        .map(item => NLStudyCountryEvent.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY, 5000)
        .map(item => NLStudy.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_REGION, 5000)
        .map(item => NLStudyRegion.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_COUNTRY, 5000)
        .map(item => NLStudyCountry.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_SITE_INI_PLAN, 5000)
        .map(item => NLStudySiteIniPlan.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_CNTRY_SITE_INI_PLN, 5000)
        .map(item => NLStudyCntrySiteIniPln.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_REGION_SITE_INI_PLN, 5000)
        .map(item => NLStudyRegionSiteIninPln.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_SUBJ_FIG_ALL, 5000)
        .map(item => NLSTtudySubjFigAll.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_CTRY_SUBJ_FIG_ALL, 5000)
        .map(item => NLStudyCtrySubjFigAll.table.bulkCreate(item, options)),
      ...chunkArray(NL_STUDY_REGION_SUBJ_FIG_ALL, 5000)
        .map(item => NLStudyRegionSubjFigAll.table.bulkCreate(item, options))
    ]);
  }

  return Promise.all([
    ...chunkArray(milestonesToSave, 5000)
      .map(item => FpoApprovedPlanMilestones.table.bulkCreate(item, options)),
    ...chunkArray(weeklyCurvesForSave, 5000)
      .map(item => FpoApprovedPlanCurves.table.bulkCreate(item, options)),
    ...chunkArray(curvesDataForSave, 5000)
      .map(item => FpoApprovedPlanCurvesDaily.table.bulkCreate(item, options))
  ]);
}

module.exports = insertHistoricalApprovedDataMilestones;
