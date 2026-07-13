export default {
  transform: {},
  coverageProvider: 'v8',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js'
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    'print-valid-links.test.js'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};
