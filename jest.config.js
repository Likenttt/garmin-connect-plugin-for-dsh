/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  watchman: false,
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/vendor/**',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 65,
      lines: 78,
      statements: 75,
    },
  },
};
