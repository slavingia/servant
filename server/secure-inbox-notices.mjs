// Email for someone writing to the team through the public page (docs/secure-inbox.md, "Reply emails").
//
// Two emails exist. A code, once, to prove the visitor reads mail at the address they typed. Then, when the team
// replies and the visitor has not seen it, a notice with the private link back to their conversation. Neither
// carries message text, a subject line, a file name, a teammate's name or a case reference: the conversation
// stays on the page. The sender is the owner's mailer command, as for sign-in codes and surveys; with no mailer
// nothing is sent and the page does not offer email.
import { secureInboxPublicUrl } from './secure-inbox.mjs';
import { magicLinkSender } from './surveys.mjs';

export const NOTICE_DELAY_SECONDS = 60;

export function inboxNoticeSettings(cfg = {}) {
  const mailer = cfg.secureInbox?.mailer || cfg.emailVerification?.mailer || null;
  const delay = cfg.secureInbox?.noticeDelaySeconds;
  // The email links to the public page, so there must be one to link to.
  const ready = !!secureInboxPublicUrl(cfg.publicUrl) && typeof mailer?.command === 'string' && !!mailer.command.trim();
  return { ready, mailer, publicUrl: cfg.publicUrl, delayMs: (Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3600) : NOTICE_DELAY_SECONDS) * 1000 };
}

// The team's name goes into a subject line: one line, no control characters.
const teamName = name => String(name ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 80) || 'the team';

export function codeMail({ team, code, minutes }) {
  const name = teamName(team);
  return {
    subject: `Your code for ${name} is ${code}`,
    text: `Your code is ${code}.\n\nEnter it on the page where you are writing to ${name}. After that we email you each time the team replies. The code works for ${minutes} minutes.\n\nIf you did not ask for this, ignore this email. Nothing more is sent to this address unless the code is entered.`,
  };
}

export function noticeMail({ team, url }) {
  const name = teamName(team);
  return {
    subject: `New reply from ${name}`,
    text: `${name} replied to your conversation.\n\nRead the reply and answer here:\n${url}\n\nThis link is private. Anyone who has it can read and reply to this conversation, so do not forward this email.\n\nTo stop these emails, open the link and choose Stop emails.`,
  };
}

export function createInboxNotices({ inbox, config, send = magicLinkSender, log = message => console.error(message) }) {
  let current = null;
  // One pass over the replies that are due an email. Resolves to how many were sent; it never rejects.
  async function pass() {
    let sent = 0;
    try {
      const cfg = config(), settings = inboxNoticeSettings(cfg);
      if (!settings.ready) return 0;
      for (const notice of inbox().claimNotices(settings.publicUrl, { delayMs: settings.delayMs })) {
        try {
          await send({ to: notice.to, url: notice.url, ...noticeMail({ team: cfg.name, url: notice.url }) }, settings);
          inbox().noticeSent(notice.id, notice.through);
          sent++;
        } catch (error) {
          inbox().noticeFailed(notice.id);
          log(`[servant] secure inbox: a reply email could not be sent: ${error?.message || error}`);
        }
      }
    } catch (error) {
      log(`[servant] secure inbox: reply emails could not be checked: ${error?.message || error}`);
    }
    return sent;
  }
  return {
    available: () => inboxNoticeSettings(config()).ready,
    // Send the code for an address. If it cannot be sent the code is forgotten and the visitor is told.
    async begin(token, body) {
      const cfg = config(), settings = inboxNoticeSettings(cfg);
      if (!settings.ready) throw Object.assign(new Error('This team does not send email. Save your return link to come back'), { status: 503, code: 'email_unavailable' });
      const { notify, mail } = inbox().guestNotifyStart(token, body);
      try {
        await send({ to: mail.to, code: mail.code, minutes: mail.minutes, ...codeMail({ team: cfg.name, code: mail.code, minutes: mail.minutes }) }, settings);
      } catch (error) {
        inbox().guestNotifyUnsent(token);
        log(`[servant] secure inbox: the code email could not be sent: ${error?.message || error}`);
        throw Object.assign(new Error('The code could not be sent. Check the address and try again, or save your return link'), { status: 502, code: 'email_send_failed' });
      }
      return { notify };
    },
    // A pass already under way is joined, not doubled.
    sweep: () => current ??= pass().finally(() => { current = null; }),
    // For shutdown: resolves when no pass is sending.
    idle: () => current ?? Promise.resolve(0),
  };
}
