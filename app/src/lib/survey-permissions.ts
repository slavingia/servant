export type SurveyPermissions = { canView: boolean; canManage: boolean };
export const NO_SURVEY_ACCESS: SurveyPermissions = { canView: false, canManage: false };

// Server permissions are authoritative. Unknown and older-server responses fail closed.
export function surveyPermissionsFromServer(value: unknown): SurveyPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NO_SURVEY_ACCESS;
  const permissions = value as Record<string, unknown>;
  const canView = permissions.canView === true;
  return { canView, canManage: canView && permissions.canManage === true };
}
