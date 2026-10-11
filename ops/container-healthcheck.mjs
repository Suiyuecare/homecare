import { checkRuntimeReadiness } from '../scripts/check-runtime-readiness.mjs';

const port = process.env.PORT || '8080';
const result = await checkRuntimeReadiness({ url: `http://127.0.0.1:${port}`, publicOrigin: process.env.HOME_CARE_PUBLIC_ORIGIN });
console.log(JSON.stringify(result.report)); process.exitCode = result.exitCode;
