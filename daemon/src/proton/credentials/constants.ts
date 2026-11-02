// Kation: changed from the CLI's 'ch.proton.drive/drive-sdk-cli' so Kation
// never reads or overwrites the official CLI's stored session.
import { APP_ID } from '../../appInfo';

export const CREDENTIALS_SERVICE = APP_ID;
export const CREDENTIALS_NAME = 'auth-session';
export const PASS_CREDENTIALS_PATH = `${CREDENTIALS_SERVICE}/${CREDENTIALS_NAME}`;
