import { randomBytes } from 'node:crypto';

const lines = [
  'COOKIE_SECRET=' + randomBytes(32).toString('base64url'),
  '',
  'Copy the values above into your .env file.',
  '',
  'The signing key (RS256 JWKS) is generated automatically on first start',
  'and persisted to $DATA_DIR/jwks.json. Do not commit it.',
];

for (const line of lines) process.stdout.write(line + '\n');
