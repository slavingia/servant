import crypto from 'node:crypto';
import { surveyPage } from './survey-page.mjs';
import { agentTierOf, RESEARCHER_TIER } from './usage.mjs';

// Public browser surveys need a direct HTTPS origin. The encrypted-only relay
// deliberately cannot serve these routes; it remains restricted to /v1/secure.
export function surveySettings(cfg) {
  let publicUrl = '';
  try {
    const url = new URL(cfg.surveys?.publicUrl || cfg.publicUrl || '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.search && !url.hash && !/^\/hubs(?:\/|$)/.test(url.pathname)) {
      publicUrl = url.href.replace(/\/+$/, '');
    }
  } catch { /* The team screen shows that public hosting needs configuration. */ }
  const mailer = cfg.surveys?.mailer || cfg.emailVerification?.mailer || null;
  return { publicUrl, mailer, emailReady: !!publicUrl && typeof mailer?.command === 'string' && !!mailer.command.trim() };
}

// Agent tiers are role labels, not ranks: engineers and product managers do
// not inherit access to private research data.
export function surveyPermissionsFor(user) {
  const canManage = user?.role === 'owner' || agentTierOf(user) === RESEARCHER_TIER;
  return { canView: canManage || agentTierOf(user) === 2, canManage };
}

export function createSurveyRoutes({ store, readBody, send, fail, clientIp, requireAuth }) {
  const token = req => /^Bearer ([A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
  const decorate = (survey, cfg) => {
    const settings = surveySettings(cfg);
    return { ...survey, shareUrl: settings.publicUrl ? `${settings.publicUrl}/s/${survey.id}` : null, emailReady: settings.emailReady };
  };
  const authorize = (req, write = false) => {
    const permissions = surveyPermissionsFor(requireAuth(req).user);
    if (!permissions.canView || (write && !permissions.canManage)) {
      throw Object.assign(new Error(write
        ? 'Only user researchers and admins can change surveys or feedback'
        : 'Only user researchers, admins and business owners can view surveys and feedback'), { status: 403, code: 'forbidden' });
    }
    return permissions;
  };
  async function body(req, staff = false) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Send a JSON request'), { status: 415, code: 'invalid_content_type' });
    // Staff can review comments expanded by redaction; public input stays small.
    const value = await readBody(req, (staff ? 96 : 16) * 1024);
    if (staff) authorize(req, true); // Recheck role and session after upload.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Send a JSON object'), { status: 400, code: 'invalid_body' });
    return value;
  }
  return {
    async public(req, res, cfg) {
      const url = new URL(req.url, 'http://server');
      const page = /^\/s\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      const api = /^\/public\/surveys\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!page && !api) return false;
      const id = (page || api)[1];
      const surveys = store();
      if (page && req.method === 'GET') {
        surveys.publicView(id); // Missing surveys get a real 404.
        const html = surveyPage(cfg?.theme);
        const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`).join(' ');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': `default-src 'none'; script-src ${hashes || "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` });
        res.end(html);
        return true;
      }
      if (!api) { fail(res, 404, 'not_found', 'Not found'); return true; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const action = api[2] || '';
      if (req.method === 'GET' && !action) send(res, 200, surveys.publicView(id, token(req)));
      else if (req.method === 'POST' && action === 'email') {
        const input = await body(req);
        const settings = surveySettings(cfg);
        if (!settings.emailReady) { fail(res, 503, 'email_unavailable', 'Email verification is not set up yet. Please try again later.'); return true; }
        send(res, 200, await surveys.startVerification(id, { email: input.email, ip: clientIp(req), publicUrl: settings.publicUrl, mailer: settings.mailer }));
      } else if (req.method === 'POST' && action === 'verify') send(res, 200, surveys.verify(id, (await body(req)).token));
      else if (req.method === 'POST' && action === 'responses') send(res, 201, { response: await surveys.submit(id, token(req), await body(req)) });
      else fail(res, 404, 'not_found', 'Not found');
      return true;
    },
    async staff(req, res, cfg) {
      const url = new URL(req.url, 'http://server');
      const match = /^\/v1\/surveys(?:\/([A-Za-z0-9_-]+)(?:\/responses\/([A-Za-z0-9_-]+))?)?$/.exec(url.pathname);
      if (!match) return false;
      const permissions = authorize(req, req.method !== 'GET');
      const surveys = store();
      const [, id, responseId] = match;
      if (!id && req.method === 'GET') send(res, 200, { surveys: surveys.list().map(s => decorate(s, cfg)), permissions });
      else if (!id && req.method === 'POST') send(res, 201, { survey: decorate(surveys.create(await body(req, true)), cfg) });
      else if (id && !responseId && req.method === 'GET') {
        const detail = surveys.detail(id);
        send(res, 200, { ...detail, survey: decorate(detail.survey, cfg), permissions });
      } else if (id && !responseId && req.method === 'PATCH') send(res, 200, { survey: decorate(surveys.update(id, await body(req, true)), cfg) });
      else if (responseId && req.method === 'PATCH') send(res, 200, { response: surveys.moderate(id, responseId, await body(req, true)) });
      else if (responseId && req.method === 'DELETE') { surveys.removeResponse(id, responseId); send(res, 200, { ok: true }); }
      else fail(res, 404, 'not_found', 'Not found');
      return true;
    },
  };
}
