import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_SURVEY_ACCESS, surveyPermissionsFromServer } from './survey-permissions.ts';

test('survey permissions deny unknown, malformed and inconsistent values', () => {
  for (const value of [undefined, null, [], true, {}, { canView: 'true', canManage: true }, { canManage: true }]) {
    assert.deepEqual(surveyPermissionsFromServer(value), NO_SURVEY_ACCESS);
  }
});

test('business owners remain read-only and survey managers can edit', () => {
  assert.deepEqual(surveyPermissionsFromServer({ canView: true, canManage: false }), { canView: true, canManage: false });
  assert.deepEqual(surveyPermissionsFromServer({ canView: true, canManage: 'true' }), { canView: true, canManage: false });
  assert.deepEqual(surveyPermissionsFromServer({ canView: true, canManage: true }), { canView: true, canManage: true });
});
