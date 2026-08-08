/**
 * Test-lead detection. Must match whole words only: a substring match treats
 * real patients (Preston, Testa, "Contest" labels) as test data, which would
 * let the NOTES_ONLY_TEST_NAMES guard write into their live record.
 */
export function isTestName(fullName: string): boolean {
  return /\btest\b/i.test(fullName);
}
