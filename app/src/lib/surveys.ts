import { request, type Account } from './server';
import type { SurveyPermissions } from './survey-permissions';

export type Survey = {
  id: string;
  title: string;
  question: string;
  closed: boolean;
  createdAt: number;
  shareUrl: string | null;
  emailReady: boolean;
};
export type SurveyResponse = {
  id: string;
  surveyId: string;
  rating: number;
  text: string;
  contactEmail: string | null;
  visibility: 'pending' | 'reviewed' | 'hidden';
  status: 'open' | 'planned' | 'resolved';
  reply: string;
  createdAt: number;
};
export type SurveyDetail = {
  permissions: SurveyPermissions;
  survey: Survey;
  results: { total: number; average: number | null; distribution: number[] };
  responses: SurveyResponse[];
};
export type ResponsePatch = Partial<Pick<SurveyResponse, 'text' | 'visibility' | 'status' | 'reply'>>;
const surveyPath = (id: string) => `/v1/surveys/${encodeURIComponent(id)}`;
async function call<T>(account: Account, path: string, method = 'GET', body?: object): Promise<T> {
  const result = await request(account, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return result.json();
}
export const surveysApi = {
  list: (account: Account) => call<{ surveys: Survey[]; permissions: SurveyPermissions }>(account, '/v1/surveys'),
  create: (account: Account, body: { title: string; question: string }) => call<{ survey: Survey }>(account, '/v1/surveys', 'POST', body),
  detail: (account: Account, id: string) => call<SurveyDetail>(account, surveyPath(id)),
  update: (account: Account, id: string, body: Partial<Pick<Survey, 'title' | 'question' | 'closed'>>) => call<{ survey: Survey }>(account, surveyPath(id), 'PATCH', body),
  respond: (account: Account, id: string, responseId: string, body: ResponsePatch) => call<{ response: SurveyResponse }>(account, `${surveyPath(id)}/responses/${encodeURIComponent(responseId)}`, 'PATCH', body),
  remove: (account: Account, id: string, responseId: string) => call<{ ok: true }>(account, `${surveyPath(id)}/responses/${encodeURIComponent(responseId)}`, 'DELETE'),
};
export const surveyFaces = ['😞', '🙁', '😐', '🙂', '😄'];
export const surveyRatingLabels = ['Very unhappy', 'Unhappy', 'Neutral', 'Happy', 'Very happy'];
export const surveyError = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
