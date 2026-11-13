"""What counts as sensitive business information, for a federal-agency team and its contractors. Edit here, regenerate, retrain."""
CATEGORIES = {
 "CREDENTIAL": "a live-looking secret: API key, access token, password, private key, connection string with a password, webhook secret, certificate private material, MFA seed. Needs an actual secret value in the text, not just the word 'password'.",
 "PROCUREMENT": "non-public acquisition details: a bid or proposal price, independent government cost estimate, source-selection or evaluation scores, competitor pricing, unannounced award decision, contract negotiation positions, vendor ranking before award.",
 "BUDGET": "non-public financial figures: unreleased budget numbers, internal spend or funding levels, forecasts, reprogramming plans, headcount-cost projections, appropriations not yet public, unpublished revenue or margin numbers.",
 "SECURITY": "security-sensitive details: unpatched vulnerability specifics, pen-test or audit findings, incident or breach details, internal hostnames and IP addresses with system architecture, firewall or access-control configuration, admin URLs, bypass methods.",
 "CONTROLLED": "material marked or clearly meant to be restricted: CUI, FOUO, 'official use only', 'internal only - do not distribute', embargoed or pre-decisional text, unreleased policy, rule, legislation, or press content, draft decisions before announcement.",
 "PERSONNEL": "non-public personnel matters: layoffs or reorganization lists, performance ratings, disciplinary or misconduct investigations, individual salary or bonus, security clearance status, EEO complaints, hiring or firing decisions about named people.",
 "PROPRIETARY": "vendor or company confidential material: trade secrets, unreleased product or roadmap details, customer lists, proprietary source code or algorithms, licensed or NDA-covered documents, confidential partnership terms.",
 "TAX_RETURN_INFO": "tax return information about a specific person or business: AGI, refund or balance due, filing or audit status, return line items, installment-agreement details, lien or levy status, tied to a named person or entity or a case.",
}
LABELS = list(CATEGORIES)
