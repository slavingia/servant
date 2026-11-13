// Only a single mailbox and the survey title go to the email app. Feedback and
// internal notes stay in Servant until a staff member chooses what to send.
export function surveyReplyUrl(contactEmail: string | null | undefined, surveyTitle: string): string | null {
  if (typeof contactEmail !== 'string' || /[\u0000-\u001f\u007f]|%0[ad]/i.test(contactEmail)) return null;
  const email = contactEmail.trim();
  const [mailbox = '', domain = ''] = email.split('@');
  if (email.length > 254 || mailbox.length > 64 || mailbox.startsWith('.') || mailbox.endsWith('.') || mailbox.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)
    || domain.split('.').some(label => label.length > 63)) return null;
  const title = surveyTitle.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  try {
    return `mailto:${encodeURIComponent(mailbox)}@${domain.toLowerCase()}?subject=${encodeURIComponent(title ? `Re: ${title}` : 'Survey feedback')}`;
  } catch { return null; } // Malformed Unicode must not break the response list.
}
