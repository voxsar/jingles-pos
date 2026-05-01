module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@jingles/shared$': '<rootDir>/../shared/src/index.ts',
    '^electron$': '<rootDir>/src/__mocks__/electron.ts',
  },
  forceExit: true,
};
