const _ = require('lodash');
const {
  regionTable: Region,
  countryTable: Country,
  overrideTable: Overrides,
  scenarioTable: Scenario
} = require('../../db_interface/ui_db_API');

/**
 * Update scenario fields
 * @param id
 * @param data
 * @returns {*}
 */
module.exports = async function updateScenario(id, data, options = {}) {
  const { locations, ...scenarioData } = data;

  // create flat location data array
  const locationsArray = _.flatMap(locations, item => (
    _.map(item.countries, country => ({ ...country }))
  ));
  /**
   * Create regions if needed
   */
  function createRegions(regions) {
    return Promise.all(regions.map(cl =>
      Region.createRegion(cl.name, options)
        .spread(region =>
          cl.countries.map(oldCountry =>
            [oldCountry.id, oldCountry.name, region.id, cl.id]))));
  }

  /**
   * Create countries if needed
   */
  function createCountries(countries) {
    return Promise.all(countries.map(c => Country.createCountry(...c.slice(0, 3), options)
      .spread(country => ({ ...country.get({ plain: true }), platformRegionId: c[3] }))));
  }

  /**
   * Create / update override data
   */
  function createOverridesData(scenario_id, countriesData) {
    return Promise.all(countriesData.map(country => {
      let newLocationData;
      if (country.name === 'Unspecified country') {
        newLocationData = locationsArray.find(item => item.region_id === country.platformRegionId
          && item.name === 'Unspecified country');
      } else {
        newLocationData = locationsArray.find(item => item.platform_country_id === country.platform_country_id);
      }

      // /**
      //  * Restrict initial countries constraint for adjusted scenario
      //  */
      // let initialConstraint;
      // const sourceCountry = sourceOverrides.find(item => item.platform_country_id === country.platform_country_id);
      // if (sourceCountry) {
      //   initialConstraint = sourceCountry.constraint;
      // }

      return Overrides.table.findOrCreate({
        where: {
          scenario_id,
          country_id: country.id
        },
        ...options,
        defaults: {
          scenario_id,
          country_id: country.id,
          constraint: newLocationData.constraint,
          patient_allocation: newLocationData.patients || null,
          patient_allocation_min: newLocationData.patients_min || null,
          patient_allocation_max: newLocationData.patients_max || null
        }
      })
        .spread((override, created) => {
          if (!created) {
            return Overrides.table.update({
              constraint: newLocationData.constraint,
              patient_allocation: newLocationData.patients || null,
              patient_allocation_min: newLocationData.patients_min || null,
              patient_allocation_max: newLocationData.patients_max || null
            }, {
              where: {
                scenario_id,
                country_id: country.id
              },
              validate: false,
              ...options
            });
          }
          return override;
        });
    }));
  }

  if (locations) {
    try {
      const newCountries = await createRegions(locations);
      const newCountriesData = await createCountries([].concat(...newCountries));

      // // Adjusted scenario edit - we have to fetch source scenario data to restrict constraints
      // let sourceOverrides = [];
      // const scenario = await Scenario.findById(id, { raw: true, attributes: ['source_scenario_id'] });
      // if (scenario.source_scenario_id !== null) {
      //   const existingCountriesIds = newCountriesData.map(item => item.id);
      //   sourceOverrides = await Overrides.findAll({
      //     where: { scenario_id: scenario.source_scenario_id, country_id: { $in: existingCountriesIds } },
      //     raw: true,
      //     attributes: ['country_id', 'constraint', 'country.platform_country_id'],
      //     include: { model: Country.table, attributes: [] }
      //   });
      // }

      await createOverridesData(id, newCountriesData);
    } catch (err) {
      throw err;
    }
  }

  if (!_.isEmpty(scenarioData)) {
    return Scenario.updateScenarioEntityById(
      id,
      _.omit(scenarioData, ['use_therapeutic_area', 'use_indication', 'use_phase', 'age_group']),
      options
    );
  }

  return false;
};
