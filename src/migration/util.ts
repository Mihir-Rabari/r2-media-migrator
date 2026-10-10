import * as os from 'node:os';
export const os_hostname = (): string => os.hostname();
export { defaultPidAlive } from './engine';
