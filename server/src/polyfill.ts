// Node 18 缺少 File 全局变量，cheerio 内部依赖的 undici 加载时需要它，此 polyfill 必须最先导入
if (typeof (globalThis as any).File === 'undefined') {
  (globalThis as any).File = class File extends Blob {
    name: string;
    lastModified: number;
    constructor(chunks: BlobPart[], name: string, options?: FilePropertyBag) {
      super(chunks, options);
      this.name = name;
      this.lastModified = options?.lastModified || Date.now();
    }
  };
}
export {};
