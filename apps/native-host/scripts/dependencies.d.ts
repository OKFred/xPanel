declare module "esbuild" {
  export function build(options: Record<string, unknown>): Promise<void>;
}

declare module "postject" {
  export function inject(
    executablePath: string,
    resourceName: string,
    resource: Uint8Array,
    options: { sentinelFuse: string; machoSegmentName?: string },
  ): Promise<void>;
}
