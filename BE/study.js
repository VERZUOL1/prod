const { PHASE } = require('../../../shared-library/constants/study');

module.exports = (sequelize, DataTypes) => {
  const studyModel = sequelize.define('study', {
    study_id: DataTypes.STRING(45),
    indication: DataTypes.STRING(100),
    therapeutic_area: DataTypes.STRING(100),
    description: DataTypes.STRING(1000),
    target_lpft: DataTypes.DATEONLY,
    is_imported: DataTypes.BOOLEAN,
    target_num_patients: DataTypes.INTEGER,
    fp: DataTypes.DATEONLY,
    owner_id: DataTypes.STRING(128),
    is_new_owner: DataTypes.BOOLEAN,
    fpfv_fpft: {
      type: DataTypes.INTEGER,
      defaultValue: 14,
      validate: {
        notEmpty: true,
        isInt: true
      }
    },
    study_details_updated_by: {
      type: DataTypes.STRING(128)
    },
    study_details_updated_at: {
      type: DataTypes.DATE
    },
    inclusion: DataTypes.TEXT('long'),
    exclusion: DataTypes.TEXT('long'),
    phase: DataTypes.ENUM(Object.values(PHASE))
  });
  studyModel.associate = models => {
    studyModel.hasMany(models.scenario, { foreignKey: 'study_id', sourceKey: 'id' });
    studyModel.hasMany(models.user_study, { foreignKey: 'study_id', sourceKey: 'id' });
  };

  return studyModel;
};
