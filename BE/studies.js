const config = require('config');
const log = require('../../utils/logger');
const uiModels = require('../../db_ui/models');
const Study = require('../db_interface/ui_db_API/').studyTable;

const {
  ROLE_ADMIN,
  ROLE_USER,
  ROLE_PLAYGROUND,
  ROLE_READONLY,
  ROLE_COUNTRY
} = config.role;

const {
  DONT_HAVE_ACCESS_TO_VIEW_PAGE,
  DONT_HAVE_ACCESS_TO_CHANGE_PLAYGROUND_STUDY,
  DONT_HAVE_ACCESS_TO_OPERATION
} = require('../constants/messages');

const { isOwner } = require('../db_interface/helpers/common');

/**
 * Validates mandatory fields before create new study
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
function validateStudyData(req, res, next) {
  const { study } = req.body;
  if (!study.study_id || study.study_id.length > 45) {
    return res.status(400)
      .json({ message: 'Study ID is incorrect' });
  }
  if (study.synchronizedWithImpact) {
    return next();
  }

  if (!study.therapeutic_area || study.therapeutic_area.length > 100) {
    return res.status(400)
      .json({ message: 'Therapeutic area is incorrect' });
  }
  if (!study.indication || study.indication.length > 100) {
    return res.status(400)
      .json({ message: 'Indication is incorrect' });
  }
  if (!study.target_num_patients
    || study.target_num_patients.length > 45
    || !(/^\d+$/.test(study.target_num_patients))) {
    return res.status(400)
      .json({ message: 'Target num patients is incorrect' });
  }
  return next();
}

/**
 * Validate compare scenario request
 * 1. can compare 2 or 3 scenarios
 * 2. scenario ID must be a number
 * 3. scenarios must belong to the same study
 * @param req
 * @param res
 * @param next
 */
function validateCompareScenariosData(req, res, next) {
  const studyId = req.params.id;
  const scenarios = Object.keys(req.query)
    .filter(item => item.startsWith('id_'))
    .map(item => {
      const id = req.query[item];
      if (id !== 'impact') {
        return +id;
      }
      return id;
    });


  // Validate scenarios list length - can compare 2 or 3 only
  if (scenarios.length < 2 || scenarios.length > 3) {
    log.error('Compare scenarios: it is possible to compare only 2 or 3 scenarios');
    const err = new Error('Compare scenarios: it is possible to compare only 2 or 3 scenarios');
    err.status = 400;
    next(err);
  }
  // Validate scenarios ids
  scenarios.forEach(id => {
    if (id !== 'impact' && !parseInt(id, 10)) {
      log.error('Compare scenarios: provided scenario ID is incorrect ', id);
      const err = new Error(`Compare scenarios: provided scenario ID is incorrect: ${id}`);
      err.status = 400;
      next(err);
    }
  });

  Study.table.find({
    where: {
      id: studyId
    },
    include: [{
      model: uiModels.scenario,
      attributes: ['id', 'owner_id']
    }],
    attributes: ['id', 'is_imported']
  })
    .then(result => {
      if (!result) return next(404);
      const foundStudy = result.get({ plain: true });

      // Validate scenarios belong to the same study
      scenarios.forEach(scenarioId => {
        const scenario = foundStudy.scenarios.find(item => item.id === scenarioId);
        if (!scenario && scenarioId !== 'impact') {
          log.error('Compare scenarios: it is possible to compare scenarios from the same study only');
          const err = new Error('Compare scenarios: it is possible to compare scenarios from the same study only');
          err.status = 400;
          next(err);
        }
      });

      /**
       * Validate user permission to view scenarios
       */
      if (foundStudy.is_imported) {
        return next();
      }
      // Check permission to view playground scenarios
      const isInvalid = foundStudy.scenarios.some(item => scenarios.indexOf(item.id) !== -1
        && !isOwner(item.owner_id, req.user.id));

      if (isInvalid) {
        const error = new Error(DONT_HAVE_ACCESS_TO_VIEW_PAGE);
        error.status = 403;
        return next(error);
      }

      return next();
    })
    .catch(err => next(new Error('Internal server error', err)));
}

/**
 * Validate permissions to access study
 * @param studyId
 * @returns {function(*, *, *)}
 */
function validateByOwner(studyId) {
  return async (req, res, next) => {
    const id = req.params[studyId];
    const currentUser = req.user;

    try {
      const study = await Study.table.findOne({
        where: { id },
        attributes: ['owner_id', 'is_imported'],
        raw: true
      });

      if (!study) {
        const error = new Error('Study not found');
        error.status = 404;

        throw error;
      }

      if (!isOwner(study.owner_id, currentUser.id) && !study.is_imported) {
        const error = new Error(DONT_HAVE_ACCESS_TO_VIEW_PAGE);
        error.status = 403;

        throw error;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Validate operation permission
 * @param studyId
 * @returns {Promise.<Model>}
 */
function validateByOwnerOrAdmin(studyId) {
  return function validate(req, res, next) {
    const error = new Error(DONT_HAVE_ACCESS_TO_CHANGE_PLAYGROUND_STUDY);
    error.status = 403;
    const id = req.params[studyId];
    // if user admin we should not check ownership
    if (req.user.role === ROLE_ADMIN) {
      return next();
    }
    // if user not admin and not system user we shpould not check ownership
    if (!req.user.role === ROLE_USER || !req.user.role === ROLE_PLAYGROUND) {
      return next(error);
    }
    return Study.table.findOne({
      where: {
        id
      },
      attributes: ['owner_id'],
      raw: true
    })
      .then(data => {
        if (isOwner(data.owner_id, req.user.id)) {
          return next();
        }
        return next(error);
      })
      .catch(err => next(err));
  };
}

/**
 * Check access level
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
function validateAccessLevel(req, res, next) {
  const error = new Error('This operation can be initiated by or applied to restricted user');
  error.status = 403;
  if (req.user.role === ROLE_ADMIN || req.user.role === ROLE_USER) {
    return next();
  }
  return next(error);
}

/**
 * Check ROLE access to playground
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
function validateAccessLevelToPlayground(req, res, next) {
  const error = new Error(DONT_HAVE_ACCESS_TO_OPERATION);
  error.status = 403;
  if (req.user.role === ROLE_ADMIN || req.user.role === ROLE_USER || req.user.role === ROLE_PLAYGROUND) {
    return next();
  }
  return next(error);
}


/**
 * Check users access to operations with study
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
async function validateAccessLevelToStudy(req, res, next) {
  const { studyId } = req.params;
  const error = new Error(DONT_HAVE_ACCESS_TO_OPERATION);
  error.status = 403;
  if (req.user.role === ROLE_ADMIN || req.user.role === ROLE_USER) {
    return next();
  } else if (req.user.role === ROLE_READONLY || req.user.role === ROLE_COUNTRY) {
    return next(error);
  }

  try {
    const study = await Study.table.findOne({
      where: {
        id: studyId
      },
      attributes: ['owner_id', 'is_imported'],
      raw: true
    });
    if (!study || (study && study.is_imported && req.user.role === ROLE_PLAYGROUND)) {
      throw error;
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = {
  validateStudyData,
  validateCompareScenariosData,
  validateByOwner,
  validateByOwnerOrAdmin,
  validateAccessLevel,
  validateAccessLevelToPlayground,
  validateAccessLevelToStudy
};
