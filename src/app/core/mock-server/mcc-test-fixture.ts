import { MccCatalogueEntry } from '../merchants/mcc';

// TEST FIXTURE – NOT AN APPROVED MCC CATALOGUE.
//
// For automated tests and for demos only, and loaded only on request (mobiDemo.loadMccTestFixture()).
// The codes are standard four-digit MCCs, but every description is prefixed "TEST –" and the
// per-country availability below is made up to exercise the rules (available, restricted, not
// available). None of it is an approved Mobi, scheme or regulatory rule.

export const MCC_TEST_FIXTURE_NAME = 'TEST FIXTURE – not an approved catalogue';
export const MCC_TEST_FIXTURE_VERSION = 'test-1';

export const MCC_TEST_FIXTURE: MccCatalogueEntry[] = [
  { code: '5411', description: 'TEST – Grocery stores', countries: { MY: 'available', ID: 'available', VN: 'available' } },
  { code: '5732', description: 'TEST – Electronics stores', countries: { MY: 'available', ID: 'available' } },
  { code: '5814', description: 'TEST – Fast food restaurants', countries: { MY: 'available', ID: 'restricted' } },
  { code: '7995', description: 'TEST – Betting and gambling', countries: { MY: 'restricted' } },
  { code: '8299', description: 'TEST – Schools and educational services', countries: { MY: 'available', ID: 'available', VN: 'available' } },
];
