// The S3 template's source is plain JavaScript so scripts/spike-s3.mjs can import
// the exact bytes the template ships (Node cannot import the studio's .ts).
// `allowJs` is off here, so tsc needs this to resolve the module.
export declare const SERVER_JS: string;
export declare const PAGE_HTML: string;
export declare const PACKAGE_JSON: string;
export declare const README_MD: string;
export declare function s3AppFiles(): Record<string, string>;