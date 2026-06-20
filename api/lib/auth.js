import { google } from 'googleapis';

/**
 * Returns a GoogleAuth client using the service account credentials.
 * Used for Sheets (and Drive read) operations.
 */
export function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    try {
      creds = JSON.parse(raw.replace(/\r?\n/g, '\\n'));
    } catch (e2) {
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${e2.message}`);
    }
  }

  if (creds.private_key?.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

/**
 * Returns an OAuth2 client for personal Drive uploads.
 */
export function getDriveAuth() {
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
  } = process.env;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing OAuth env vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN');
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/**
 * Throws if the request body does not carry a valid admin token.
 */
export function requireToken(body) {
  if (!body._token || body._token !== process.env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
}
