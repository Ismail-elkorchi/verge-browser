/** Explicit per-activation image limits. Work is serialized, including decoder workspace. */
export interface ImagePolicyOptions {
  readonly maxResources?: number;
  readonly maxEncodedBytes?: number;
  readonly maxTotalEncodedBytes?: number;
  readonly maxDimension?: number;
  readonly maxPixels?: number;
  readonly maxTotalDecodedBytes?: number;
  readonly maxWorkspaceBytes?: number;
  readonly maxDecodeMilliseconds?: number;
  readonly maxRequestMilliseconds?: number;
  readonly maxTotalMilliseconds?: number;
  readonly maxRedirects?: number;
}
export const DEFAULT_IMAGE_POLICY: Required<ImagePolicyOptions> = Object.freeze({
  maxResources: 32,
  maxEncodedBytes: 2 * 1024 * 1024,
  maxTotalEncodedBytes: 8 * 1024 * 1024,
  maxDimension: 4096,
  maxPixels: 2 * 1024 * 1024,
  maxTotalDecodedBytes: 32 * 1024 * 1024,
  maxWorkspaceBytes: 128 * 1024 * 1024,
  maxDecodeMilliseconds: 1500,
  maxRequestMilliseconds: 5000,
  maxTotalMilliseconds: 20000,
  maxRedirects: 5
});
export function imagePolicy(options: ImagePolicyOptions = {}): Required<ImagePolicyOptions> {
  const policy = { ...DEFAULT_IMAGE_POLICY, ...options };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      throw new RangeError(`${key} must be a non-negative safe integer no greater than 2147483647.`);
    }
  }
  return Object.freeze(policy);
}
