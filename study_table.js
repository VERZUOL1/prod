const { get, omit, uniq, pick } = require('lodash');
const moment = require('moment');
const Study = require('../../../db_ui/models').study;
const Scenario = require('../../../db_ui/models').scenario;
const Sequelize = require('../../../db_ui/models').sequelize;
const ScenarioTable = require('./scenario_table');
const userStudyTable = require('./user_study_table');
const userScenarioTable = require('./user_scenario_table');
const ArchiveScenarioTable = require('./archive_scenario_table');
const ScenarioCohort = require('./cohorts_table');
const platformStudy = require('../platform_db_API/').studyTable;
const IndicationTable = require('../platform_db_API/').indicationTable;
const TherapeuticAreaTable = require('../platform_db_API/').therapeuticAreaTable;
const Users = require('../users_db_API/').mapTable;
const HistoricalReferenceStudy = require('./historical_reference_study_table');
const PlannedStudyCountryTable = require('../platform_db_API/').plannedStudyCountryTable;
const { getActualValuesForScenario, getEarlyActualsByStudy } = require('../../db_interface/helpers/actuals');
const log = require('../../../utils/logger');
const { isOwner } = require('../helpers/common');
const OriginScenarioDTO = require('./DTO/scenarioOriginDTO');
const StudyStatus = require('./aux_study_status');

const { SCENARIO_STATUS, STUDY_STATUS } = require('../../constants');

/**
 * Returns true in case study exist
 * @param studyId
 * @param userId
 * @param isPlayground
 * @param id
 */
async function isExist(studyId, userId, isPlayground, id) {
  const { Op } = Sequelize;
  const study = await Study.findOne({
    where: {
      study_id: studyId,
      owner_id: userId,
      is_imported: !isPlayground,
      id: { [Op.not]: id }
    }
  });

  return !!study;
}

/**
 * get study and all related data by id
 * @param id
 */
const findAllById = id =>
  Study.findById(
    id,
    { include: [{ all: true }] }
  );

/**
 * Fetches study data
 */
async function getStudyById(id, user, archived) {
  try {
    const studyObj = await Study.findOne({
      where: {
        id
      },
      include: [
        { model: StudyStatus.table }
      ]
    });
    const studyScenarios = await ScenarioTable.findScenariosByStudyId(id, {
      include: [{
        model: userScenarioTable.table,
        attributes: ['user_id'],
        raw: true
      }, {
        model: ArchiveScenarioTable.table,
        where: { user_id: user.id },
        required: false,
        as: 'is_archived',
        attributes: ['id']
      }, {
        model: ScenarioCohort.table
      }]
    });
    if (!studyObj) {
      const error = new Error(`Study ${id} not found.`);
      error.status = 404;
      throw error;
    }
    let study = studyObj.get({ plain: true });
    study.scenarios = studyScenarios.map(item => item.get({ plain: true }));
    let pStudy = null;
    if (study.is_imported) {
      pStudy = await platformStudy.getStudyWithFullDetails(study.study_id, { raw: true });
      if (pStudy) {
        study.impactStudyParams = {
          ...pick(pStudy, ['target_lpft', 'fp', 'target_num_patients', 'description']),
          indication: get(pStudy, 'indication.name'),
          therapeutic_area: get(pStudy, 'indication.therapeutic_area.name'),
          phase: get(pStudy, 'phase.name')
        };


        /**
         * If study doesn't have any scenarios we update its parameters with latest ones that came from Impact
         * Once we create first scenario study will be updated with its own set
         */
        if (!study.impactParams) {
          study = { ...study, ...study.impactStudyParams, synchronizedWithImpact: true };
        }
      } else {
        log.debug(`Impact information for study is absent: ${study.study_id}`);
      }
    }

    const earlyActualsData = await getEarlyActualsByStudy([study.study_id]);
    const earlyActuals = earlyActualsData
      .reduce((res, item) => {
        res[item.study_id] = item.earliest_actual_date;
        return res;
      }, {});
    study.earlyActualsAlert = earlyActuals[study.study_id] && study.fp > earlyActuals[study.study_id];

    study.historical_references = [...await HistoricalReferenceStudy.getAllByStudyId(study.id, true)];

    const owner = await Users.getUserDTOById(study.owner_id);
    const state = {
      isOwner: isOwner(study.owner_id, user.id),
      status: study.aux_study_status ? study.aux_study_status.status : get(pStudy, 'status', null),
      owner_name: get(owner, 'name', '-')
    };

    delete study.owner_id;

    study.archivedCount = 0;

    if (!user.privileges.canSeeAllScenariosOfStudy) {
      study.scenarios = study.scenarios
        .filter(scenario => scenario.status === SCENARIO_STATUS.APPROVED
          || scenario.status === SCENARIO_STATUS.PREV_APPROVED
          || isOwner(scenario.owner_id, user.id)
          || scenario.user_scenarios.find(item => item.user_id === user.id));
    }

    study.scenarios = study.scenarios.filter(item => {
      if (item.is_archived && item.is_archived.length) {
        study.archivedCount += 1;
      }

      if (archived && item.is_archived && item.is_archived.length) {
        return true;
      } else if (!archived && (!item.is_archived || !item.is_archived.length)) {
        return true;
      }
      return false;
    });

    study.scenarios = await Promise.all(study.scenarios.map(async scenarioObject => {
      const preparedScenarioObject = scenarioObject;
      const { predicted_lpft, approved_data_snapshot } = preparedScenarioObject;
      if (predicted_lpft) {
        preparedScenarioObject.approved_data_snapshot = null;
      } else if (get(approved_data_snapshot, 'fullData')) {
        const fullData = JSON.parse(get(approved_data_snapshot, 'fullData'));
        const global = get(fullData, '_Global Rollup', {});
        const dataSource = get(global, 'overallocatedData', global);
        if (dataSource && dataSource.fpfv_lpfv && dataSource.lpft) {
          preparedScenarioObject.approved_data_snapshot = null;
          preparedScenarioObject.predicted_lpft = dataSource.lpft;
          preparedScenarioObject.predicted_fpfv_lpfv = dataSource.fpfv_lpfv;
          preparedScenarioObject.predicted_patient_allocation = global.patient_allocation;
          preparedScenarioObject.predicted_num_sites = global.num_sites;
          preparedScenarioObject.predicted_num_countries = scenarioObject.overrides && scenarioObject.overrides.length;
        }
      } else if (get(approved_data_snapshot, 'aggregatedGlobalData')) {
        const global = JSON.parse(get(approved_data_snapshot, 'aggregatedGlobalData'));
        if (global && global.fpfv_lpfv && global.lpft) {
          preparedScenarioObject.approved_data_snapshot = null;
          preparedScenarioObject.predicted_lpft = global.lpft;
          preparedScenarioObject.predicted_fpfv_lpfv = global.fpfv_lpfv;
          preparedScenarioObject.predicted_patient_allocation = global.patient_allocation;
          preparedScenarioObject.predicted_num_sites = global.num_sites;
          // preparedScenarioObject.predicted_num_countries = global.predicted_num_countries;
          const uniqCountries = scenarioObject.scenario_cohorts
            && scenarioObject.scenario_cohorts.reduce((res, item) => {
              if (item.overrides) {
                item.overrides.forEach(override => {
                  res.add(override.country_id);
                });
              }

              return res;
            }, new Set());
          preparedScenarioObject.predicted_num_countries = uniqCountries ? uniqCountries.size : 0;
        }
      }
      const scenarioOwner = await Users.getUserDTOById(preparedScenarioObject.owner_id);
      const scenarioState = {
        isOwner: isOwner(user.id, preparedScenarioObject.owner_id),
        isShared: !!(preparedScenarioObject.user_scenarios
          && preparedScenarioObject.user_scenarios.length)
      };
      preparedScenarioObject.cohorts = preparedScenarioObject.scenario_cohorts;
      delete preparedScenarioObject.scenario_cohorts;

      preparedScenarioObject.originScenario = null;
      if (preparedScenarioObject.origin_scenario_id !== null) {
        const originScenario = study.scenarios.find(item => item.id === preparedScenarioObject.origin_scenario_id);
        if (originScenario) {
          preparedScenarioObject.originScenario = new OriginScenarioDTO(
            originScenario.name,
            study.study_id,
            originScenario.status,
            originScenario.source_scenario_id !== null,
            originScenario.createdAt,
            originScenario.fp
          );
        }
      } else if (preparedScenarioObject.source_scenario_id !== null) {
        const originScenario = study.scenarios.find(item => item.id === preparedScenarioObject.source_scenario_id);
        if (originScenario) {
          preparedScenarioObject.originScenario = new OriginScenarioDTO(
            originScenario.name,
            study.study_id,
            originScenario.status,
            originScenario.source_scenario_id !== null,
            originScenario.createdAt,
            originScenario.fp
          );
        }
      }
      return {
        ...preparedScenarioObject,
        end_date: study.target_lpft,
        state: scenarioState,
        owner_name: get(scenarioOwner, 'name', '-'),
        is_archived: preparedScenarioObject.is_archived.length !== 0
      };
    }));

    delete study.impactParams;

    return { ...study, state };
  } catch (err) {
    throw err;
  }
}

/**
 * Fetches playgroud study owned by user
 */
async function getOwnPlaygroundStudyById(study_id, userId) {
  try {
    return await Study.findOne({
      where: {
        study_id,
        owner_id: userId,
        is_imported: false
      }
    });
  } catch (e) {
    throw e;
  }
}

/**
 *
 * @param study_id
 * @param options
 * @returns {Promise.<Model>}
 */
async function findImportedStudyByStudyId(study_id, userId, options = {}) {
  const predicate = Sequelize.where(Sequelize.fn('lower', Sequelize.col('study_id')), study_id.toLowerCase());
  const allOptions = Object.assign({ where: { predicate, is_imported: true } }, options);
  const study = await Study.findOne(allOptions);

  if (study) {
    const foundStudy = study.get({ plain: true });
    /**
     * State object
     */
    const state = {
      isOwner: isOwner(foundStudy.owner_id, userId)
    };

    return { ...foundStudy, state };
  }

  return null;
}
/**
 * Load full study data including scenario //legacy: getStudyById
 */
async function getStudyWithScenariosById(
  id,
  onlyArchived = false,
  user,
  skipOptionalData = false,
  useApprovedData = false
) {
  try {
    const study = await Study.findOne({
      where: {
        id
      },
      include: [
        {
          model: Scenario,
          attributes: ['id', 'status', 'owner_id'],
          include: {
            model: userScenarioTable.table,
            attributes: ['user_id'],
            raw: true
          }
        },
        { model: StudyStatus.table }
      ]
    });
    if (!study) {
      const error = new Error(`Study ${id} not found.`);
      log.error(`Study ${id} not found.`);
      error.status = 404;
      throw error;
    }

    const foundStudy = study.get({ plain: true });
    let { scenarios } = foundStudy;
    if (!user.privileges.canSeeAllScenariosOfStudy) {
      scenarios = foundStudy.scenarios
        .filter(sc =>
          sc.status === SCENARIO_STATUS.APPROVED
          || isOwner(sc.owner_id, user.id)
          || sc.user_scenarios.findIndex(us => isOwner(us.user_id, user.id)) !== -1);
    }

    const owner = await Users.getUserDTOById(study.owner_id);

    const linkedHistoricalStudies = await HistoricalReferenceStudy.getAllByStudyId(foundStudy.id)
      .map(item => item.get({ plain: true }));
    foundStudy.historical_references = [...linkedHistoricalStudies];
    /**
     * State object
     */
    const state = {
      isOwner: isOwner(foundStudy.owner_id, user.id),
      status: null,
      owner_name: owner ? owner.name : ''
    };
    let impactStudyParams = null;
    let countriesWithActualData = null;
    if (study.get('is_imported') === true) {
      const pStudy = await platformStudy.getStudyWithFullDetails(foundStudy.study_id, { raw: true });
      if (pStudy) {
        impactStudyParams = Object.assign({}, {
          target_lpft: pStudy.target_lpft,
          fp: pStudy.fp,
          target_num_patients: pStudy.target_num_patients,
          indication: pStudy['indication.name'],
          therapeutic_area: pStudy['indication.therapeutic_area.name']
        });
      } else {
        log.debug(`Impact information for study is absent: ${study.study_id}`);
      }
      state.status = study.aux_study_status ? study.aux_study_status.status : (pStudy && pStudy.status) || null;

      if (pStudy && state.status === 'ACTIVE') {
        const data = await getActualValuesForScenario(pStudy.study_id);
        const { actualsParameters } = data;
        countriesWithActualData = uniq([...actualsParameters.map(item => item.country_id)]);
      }
    }

    return Promise.all(scenarios.map(item =>
      ScenarioTable.getScenarioDataByID(item.id, user, false, skipOptionalData, null, useApprovedData)))
      .then(res => res.reduce((obj, scenario) => {
        const result = obj;
        if (scenario.is_archived) {
          result.archivedCount += 1;
        }
        if (onlyArchived && scenario.is_archived) {
          result.scenarios.push(scenario);
        } else if (!onlyArchived && !scenario.is_archived) {
          result.scenarios.push(scenario);
        }
        return result;
      }, { archivedCount: 0, scenarios: [] }))
      .then(res => {
        if (state.status === 'ACTIVE'
          && !res.scenarios.some(scenario => scenario.status === 'APPROVED')) {
          return PlannedStudyCountryTable.getImpactScenarioById(foundStudy.id)
            .then(impactScenario => {
              if (onlyArchived && impactScenario.is_archived) {
                return {
                  ...res,
                  scenarios: [...res.scenarios, impactScenario]
                };
              } else if (!onlyArchived && !impactScenario.is_archived) {
                return {
                  ...res,
                  scenarios: [...res.scenarios, impactScenario]
                };
              }
              return res;
            })
            .catch(e => {
              // if impact scenario or study doesn't exist
              if (e.status === 404) {
                return res;
              }
              log.error(`getStudyWithScenariosById, Study id: ${id}`);
              throw e;
            });
        }
        return res;
      })
      .then(res => Object.assign(
        {},
        omit(foundStudy, 'owner_id'),
        res,
        { state, impactStudyParams, countriesWithActualData }
      ));
  } catch (err) {
    throw err;
  }
}

/**
 * Fetch all user studies
 * @param userId
 * @returns {Promise.<Array.<Model>>}
 */
async function getStudiesByUserId(userId) {
  try {
    const archivedScenariosIds = await ArchiveScenarioTable.findArchivedScenarioIdsByUserId(userId, {
      raw: true,
      attributes: ['id']
    });
    const studies = await Study.findAll({
      order: [['updatedAt', 'DESC']],
      include: [
        { model: userStudyTable.table, where: { user_id: userId }, attributes: [] },
        {
          model: ScenarioTable.table,
          attributes: ['id', 'name', 'status', 'fp', 'target_lpft',
            'therapeutic_area', 'indication', 'fpfv_fpft', 'target_num_patients']
        },
        { model: StudyStatus.table }
      ]
    })
      .map(async item => {
        let study = item.get({ plain: true });
        if (study.is_imported) {
          /**
           * If study doesn't have any scenarios we update its parameters with latest ones that came from Impact
           * Once we create first scenario study will be updated with its own set
           */
          const pStudy = await platformStudy.getStudyWithFullDetails(study.study_id, { raw: true });
          if (pStudy) {
            const impactStudyParams = Object.assign({}, {
              target_lpft: pStudy.target_lpft,
              fp: pStudy.fp,
              target_num_patients: pStudy.target_num_patients,
              indication: pStudy['indication.name'],
              therapeutic_area: pStudy['indication.therapeutic_area.name']
            });
            if (!item.get('impactParams')) {
              study = { ...study, ...impactStudyParams, synchronizedWithImpact: true };
            }
          } else {
            log.debug(`Impact information for study is absent: ${study.study_id}`);
          }
        }

        let hasApprovedScenario = false;
        let outdatedApprove = false;
        const scenarioNames = study.scenarios.map(scenarioItem => {
          if (scenarioItem.status === SCENARIO_STATUS.APPROVED) {
            hasApprovedScenario = true;
            if (scenarioItem.fp && scenarioItem.target_lpft && scenarioItem.therapeutic_area
              && scenarioItem.indication && scenarioItem.target_num_patients) {
              outdatedApprove = study.fp !== moment(scenarioItem.fp)
                .format('YYYY-MM-DD')
                || study.target_lpft !== moment(scenarioItem.target_lpft)
                  .format('YYYY-MM-DD')
                || study.fpfv_fpft !== scenarioItem.fpfv_fpft
                || study.target_num_patients !== scenarioItem.target_num_patients
                || study.therapeutic_area !== scenarioItem.therapeutic_area
                || study.indication !== scenarioItem.indication;
            }
          }
          return scenarioItem.name;
        });
        return {
          ...study,
          scenarios: study.scenarios.filter(scenarioItem =>
            !archivedScenariosIds.find(archived => archived.id === scenarioItem.id)).length,
          scenarioNames,
          outdatedApproveWarning: outdatedApprove,
          approveAlert: moment()
            .diff(study.fp, 'd') >= 84 && !hasApprovedScenario
        };
      });
    const studiesIds = studies.map(study => study.study_id);

    const platformStudies = await platformStudy.findAll({
      where: { study_id: { $in: studiesIds } },
      include: {
        model: IndicationTable.table,
        include: {
          model: TherapeuticAreaTable.table
        }
      }
    });
    const users = await Users.getAllUsersDTO();

    const earlyActualsData = await getEarlyActualsByStudy(studiesIds);
    const earlyActuals = earlyActualsData
      .reduce((res, item) => {
        res[item.study_id] = item.earliest_actual_date;
        return res;
      }, {});

    return studies.map(study => {
      const pStudy = platformStudies.find(s => s.study_id === study.study_id && !!study.is_imported);
      let impactStudyParams = null;
      if (study.is_imported && pStudy) {
        const indication = pStudy.get('indication', { plain: true });
        if (indication !== null) {
          impactStudyParams = Object.assign({}, {
            target_lpft: pStudy.target_lpft,
            fp: pStudy.fp,
            target_num_patients: pStudy.target_num_patients,
            indication: indication.name,
            therapeutic_area: indication.therapeutic_area.name
          });
        }
      }
      const owner = users.find(u => isOwner(study.owner_id, u.id));
      const state = {
        isOwner: isOwner(study.owner_id, userId),
        status: study.aux_study_status ? study.aux_study_status.status : (pStudy && pStudy.status) || null,
        owner_name: owner ? owner.name : ''
      };
      return {
        ...omit(study, 'owner_id', 'impactParams'),
        /**
         * Here we need double inversion to convert 0, 1 values to boolean.
         * As we use 'raw'=true option in select to prevent circular dependencies
         * while parsing to JSON.
         */
        is_imported: !!study.is_imported,
        is_new_owner: !!study.is_new_owner,
        state,
        impactStudyParams,
        approveAlert: study.approveAlert && pStudy && pStudy.status === STUDY_STATUS.PLANNED,
        earlyActualsAlert: earlyActuals[study.study_id] && study.fp > earlyActuals[study.study_id]
      };
    });
  } catch (err) {
    log.error(`getStudiesByUserId: user_id ${userId}`);
    throw err;
  }
}

/**
 * Create new study
 * @param newStudy
 * @param userId
 * @param options
 * @returns {Promise.<Model, created>}
 */
async function addNewStudy(newStudy, userId, options = {}) {
  const predicate = Sequelize.where(Sequelize.fn('lower', Sequelize.col('study_id')), newStudy.study_id.toLowerCase());
  const userCondition = Sequelize.where(Sequelize.fn('lower', Sequelize.col('owner_id')), userId);
  const isImportedCondition = Sequelize.where(
    Sequelize.fn('lower', Sequelize.col('is_imported')),
    !!newStudy.is_imported
  );
  const allOptions = { where: { predicate, userCondition, isImportedCondition }, defaults: newStudy, ...options };
  return Study.findOrCreate(allOptions);
}

/**
 * Updates a study
 */
function updateStudy(id, data, options = {}) {
  return Study.update(
    data,
    { where: { id }, ...options }
  );
}

/**
 * Update specific field in study table
 * @param fieldName
 * @param fieldValue
 * @param id
 * @param options
 */
function updateStudyField(fieldName, fieldValue, id, options = {}) {
  const allOptions = {
    where: { id },
    validate: false
  };
  return Study.update({ [fieldName]: fieldValue }, Object.assign(allOptions, options));
}

/**
 *
 */
function updateStudyTable(id, studyData, options = {}) {
  const allOptions = {
    where: { id },
    validate: false
  };

  const { study } = studyData;

  return Study.update(study, { ...allOptions, ...options });
}

/**
 * Creates new study in DB
 */
async function createNewStudy(studyData, user, options = {}) {
  try {
    const [study, isCreated] = await addNewStudy(studyData, user.id, options);
    if (!isCreated) {
      const error = new Error('Study id duplication');
      error.status = 400;
      throw error;
    }
    await userStudyTable.assignStudyToUser(study.id, user.id, options);

    return {
      ...study.get({ plain: true }),
      scenarios: 0
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Delete study and unassign it
 */
async function deleteStudy(id, user_id) {
  await userStudyTable.unassignStudyFromUser(id, user_id);
  const study = await Study.findById(id);
  if (!study.is_imported) {
    await Study.destroy({ where: { id } });
  }
}
/**
 *
 * @param scenario_id
 */
async function findStudyByScenarioId(scenario_id, options = {}) {
  return Study.findOne({ include: { model: Scenario, where: { id: scenario_id } }, ...options });
}

module.exports = {
  table: Study,
  isExist,
  findAllById,
  findAll: options => Study.findAll(options),
  findById: (id, options = {}) => Study.findOne({ where: { id } }, options),
  getStudyWithScenariosById,
  getStudiesByUserId,
  getStudyById,
  getOwnPlaygroundStudyById,
  addNewStudy,
  updateStudyField,
  updateStudyTable,
  findImportedStudyByStudyId,
  createNewStudy,
  updateStudy,
  deleteStudy,
  findStudyByScenarioId,
  findStudyByOwner: (owner_id, options) => Study.findAll(Object.assign({ where: { owner_id } }, options))
};
