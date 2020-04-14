const UserRoleMapTable = require('../../server//db_interface/users_db_API/').mapTable;
const { ODA_API_JOB_STATUS } = require('../../server/constants');
const moment = require('moment');
const lodash = require('lodash');

const dateFormat = 'YYYY-MMThh:mm:ss.Z';
const scenarioFields = ['name', 'status', 'fpfv_fpft'];

module.exports = (sequelize, DataTypes) => {
  const scenarioModel = sequelize.define('scenario', {
    study_id: {
      type: DataTypes.INTEGER,
      validate: {
        notEmpty: true,
        isInt: true
      }
    },
    name: {
      type: DataTypes.STRING(45),
      validate: {
        notEmpty: true,
        len: [1, 45]
      }
    },
    hasAdjustedOrigin: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    updated: DataTypes.DATE,
    status: {
      type: DataTypes.ENUM('APPROVED', 'OPEN', 'PREV. APPROVED'),
      defaultValue: 'OPEN'
    },
    nerve_job_status: {
      type: DataTypes.ENUM('queued', 'running', 'failed', 'finished'),
      defaultValue: null
    },
    nerve_job_id: {
      type: DataTypes.STRING(255),
      defaultValue: null
    },
    last_optimisation_date: DataTypes.DATE,
    owner_id: DataTypes.STRING(128),
    source_scenario_id: DataTypes.INTEGER,
    approved_data_snapshot: DataTypes.TEXT('long'),
    origin_scenario_id: DataTypes.INTEGER,
    therapeutic_area: DataTypes.STRING(100),
    indication: DataTypes.STRING(100),
    target_num_patients: DataTypes.INTEGER,
    fp: DataTypes.DATEONLY,
    target_lpft: DataTypes.DATEONLY,
    fpfv_fpft: DataTypes.INTEGER,
    exact_copy: DataTypes.BOOLEAN,
    site_selection_required: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    approvedAt: DataTypes.DATE
  }, {
    timestamps: true,
    validate: {
      startDateActual() {
        if (moment(this.start_date, dateFormat)
          .diff(moment()
            .startOf('day')) < 0) {
          throw new Error('Start date not actual');
        }
      }
    },
    getterMethods: {
      study_level_data() {
        const therapeutic_area = this.getDataValue('therapeutic_area');
        const indication = this.getDataValue('indication');
        const target_num_patients = this.getDataValue('target_num_patients');
        const fp = this.getDataValue('fp');
        const target_lpft = this.getDataValue('target_lpft');
        const fpfv_fpft = this.getDataValue('fpfv_fpft');
        if (!therapeutic_area && !indication && !target_num_patients && !fp && !target_lpft) {
          return null;
        }
        return {
          therapeutic_area,
          indication,
          target_num_patients,
          fp,
          target_lpft,
          fpfv_fpft
        };
      },
      approved_data_snapshot() {
        const snapshot = JSON.parse(this.getDataValue('approved_data_snapshot') || null);
        if (!snapshot) {
          return null;
        }
        const therapeutic_area = this.getDataValue('therapeutic_area');
        const indication = this.getDataValue('indication');
        const target_num_patients = this.getDataValue('target_num_patients');
        const fp = this.getDataValue('fp');
        const target_lpft = this.getDataValue('target_lpft');
        const fpfv_fpft = this.getDataValue('fpfv_fpft');
        if (!therapeutic_area && !indication && !target_num_patients && !fp && !target_lpft) {
          return null;
        }
        return {
          ...snapshot,
          therapeutic_area,
          indication,
          target_num_patients,
          fp,
          target_lpft,
          fpfv_fpft
        };
      }
    },
    setterMethods: {
      study_level_data(values) {
        if (!values) return;

        const {
          therapeutic_area,
          indication,
          target_num_patients,
          fp,
          target_lpft,
          fpfv_fpft
        } = values;

        this.setDataValue('therapeutic_area', therapeutic_area);
        this.setDataValue('indication', indication);
        this.setDataValue('target_num_patients', target_num_patients);
        this.setDataValue('fp', fp);
        this.setDataValue('target_lpft', target_lpft);
        this.setDataValue('fpfv_fpft', fpfv_fpft);
      },
      approved_data_snapshot(value) {
        if (!value) return;

        this.setDataValue('approved_data_snapshot', JSON.stringify(value));
      }
    }
  });

  scenarioModel.beforeBulkUpdate(options => {
    /* eslint-disable no-param-reassign */
    if (options.fields.some(field => scenarioFields.indexOf(field) !== -1)) {
      options.fields.push('updated');
      options.attributes.updated = sequelize.fn('now');
    }
    /* eslint-enable */
    return true;
  });

  scenarioModel.afterBulkUpdate(options => {
    if (options.fields.includes('updated')) {
      return options.model.findAll({
        where: lodash.omit({ ...options.where, ...options.attributes }, 'updated'),
        attributes: ['study_id'],
        transaction: options.transaction,
        raw: true
      })
        .then(data => {
          const ids = lodash.uniqBy(data, 'study_id')
            .map(item => item.study_id);
          return sequelize.models.study.update(
            { updatedAt: sequelize.fn('now') },
            {
              where: { id: { $in: ids } },
              transaction: options.transaction
            }
          );
        });
    }
    return true;
  });

  /**
   * Get scenario owner's name and populate scenario model
   */
  scenarioModel.afterFind(async scenario => {
    if (scenario && scenario.owner_id) {
      try {
        let user = await UserRoleMapTable.getUserDTOById(scenario.owner_id);
        if (!user) {
          user = { name: null };
        }
        if (scenario.setDataValue && typeof scenario.setDataValue === 'function') {
          scenario.setDataValue('owner_name', user.name);
        } else {
          // eslint-disable-next-line
          scenario.owner_name = user.name;
        }
      } catch (e) {
        throw new Error("Couldn't get scenario owner name");
      }
    }
  });

  scenarioModel.hook('afterCreate', (scenario, options = {}) => {
    sequelize.models.study.update(
      {
        updatedAt: sequelize.fn('now')
      },
      {
        where: {
          id: scenario.study_id
        },
        transaction: options.transaction || null
      }
    );
  });

  scenarioModel.hook('afterSave', scenario => {
    const { study_id, nerve_job_status } = scenario;
    const values = { updatedAt: sequelize.fn('now') };

    if (nerve_job_status === ODA_API_JOB_STATUS.FINISHED) {
      sequelize.models.study.update(values, { where: { id: study_id } });
    }
  });

  scenarioModel.associate = models => {
    scenarioModel.belongsTo(models.study, { foreignKey: 'study_id', targetKey: 'id' });
    scenarioModel.hasMany(models.override, { foreignKey: 'scenario_id', sourceKey: 'id' });
    scenarioModel.hasMany(models.user_scenario, { foreignKey: 'scenario_id', sourceKey: 'id' });
    scenarioModel.hasMany(models.archive_scenario, { foreignKey: 'scenario_id', sourceKey: 'id', as: 'is_archived' });
    scenarioModel.hasMany(models.event, { foreignKey: 'scenario_id', sourceKey: 'id' });
    scenarioModel.hasMany(models.scenario_cohort, { foreignKey: 'scenario_id', sourceKey: 'id' });
    scenarioModel.hasMany(models.adjust_actual_snapshot, { foreignKey: 'scenario_id', sourceKey: 'id' });
    scenarioModel.hasMany(models.scenario_site, { foreignKey: 'scenario_id', sourceKey: 'id' });
  };
  // todo: add index to scenario_id field
  return scenarioModel;
};
