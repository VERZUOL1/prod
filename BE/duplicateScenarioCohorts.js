const { omit } = require('lodash');
const createSlaveCohortsHelper = require('../createSlaveCohortsHelper');
const {
  duplicateEvents,
  proceedCohortOrphans
} = require('./duplication');
const { SCENARIO_CONSTRAINTS } = require('../../constants');
const { adjustActualSnapshot: AdjustActualSnapshot } = require('../../db_interface/ui_db_API');
const { parameterActualTable: PlatformParameterActuals } = require('../../db_interface/platform_db_API');


module.exports = async function (
  sourceCohorts,
  newScenario,
  sourceScenario,
  exactAdjustedCopy,
  study,
  transaction
) {
  const { id } = sourceScenario;
  // detect all overrides with excluded constraint for cohort
  const excludedCountries = sourceCohorts.reduce((excludedOverrides, cohort) => {
    const exclusionForCohort = cohort.overrides.filter(c => c.constraint === SCENARIO_CONSTRAINTS.EXCLUDE);
    excludedOverrides.push(...exclusionForCohort);
    return excludedOverrides;
  }, []);
  const allActualsForStudy = await PlatformParameterActuals
    .getActualsByStudyId(study.study_id, { raw: true, attributes: ['cohort_name', 'country_id'] });

  const duplicatedCohorts = await createSlaveCohortsHelper(
    sourceCohorts.map(sc => sc.get({ plain: true })),
    [],
    newScenario.get('id'),
    { transaction, existingActuals: allActualsForStudy }
  );

  // ******* SNAPSHOTS ********
  const cohortsIdsMap = new Map();
  duplicatedCohorts.forEach(cohort => cohortsIdsMap.set(cohort.old_id, cohort.id));

  if (exactAdjustedCopy || sourceScenario.get('source_scenario_id') !== null) {
    const snapshots = await AdjustActualSnapshot.findByScenarioId(id, { raw: true });
    await Promise.all(snapshots
      .map(snapshot => {
        // if country was excluded in source scenario we not need create copy of snapshot
        if (excludedCountries.some(ec => ec.country_id === snapshot.country_id
          && ec.cohort_id === snapshot.cohort_id)) {
          return Promise.resolve();
        }
        return AdjustActualSnapshot
          .create(
            {
              ...omit(snapshot, ['id', 'country']),
              scenario_id: newScenario.get('id'),
              cohort_id: cohortsIdsMap.get(snapshot.cohort_id)
            },
            { transaction }
          );
      }));
  }
  await duplicateEvents(id, newScenario.get('id'), cohortsIdsMap, excludedCountries, transaction);
  await proceedCohortOrphans(
    sourceCohorts,
    duplicatedCohorts,
    study.get('study_id'), newScenario.get('id'), transaction
  );
  return duplicatedCohorts;
};
