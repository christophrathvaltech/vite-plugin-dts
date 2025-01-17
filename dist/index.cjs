'use strict';

const node_path = require('node:path');
const node_fs = require('node:fs');
const promises = require('node:fs/promises');
const node_os = require('node:os');
const languageCore = require('@vue/language-core');
const ts = require('typescript');
const pluginutils = require('@rollup/pluginutils');
const vueTsc = require('vue-tsc');
const debug = require('debug');
const kolorist = require('kolorist');
const apiExtractor = require('@microsoft/api-extractor');

function _interopDefaultCompat (e) { return e && typeof e === 'object' && 'default' in e ? e.default : e; }

const ts__default = /*#__PURE__*/_interopDefaultCompat(ts);
const debug__default = /*#__PURE__*/_interopDefaultCompat(debug);

const windowsSlashRE = /\\+/g;
function slash(p) {
  return p.replace(windowsSlashRE, "/");
}
function normalizePath(id) {
  return node_path.posix.normalize(slash(id));
}
function resolve(...paths) {
  return normalizePath(node_path.resolve(...paths));
}
function isNativeObj(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}
function isRegExp(value) {
  return Object.prototype.toString.call(value) === "[object RegExp]";
}
function isPromise(value) {
  return !!value && (typeof value === "function" || typeof value === "object") && typeof value.then === "function";
}
async function wrapPromise(maybePromise) {
  return isPromise(maybePromise) ? await maybePromise : maybePromise;
}
function ensureAbsolute(path, root) {
  return normalizePath(path ? node_path.isAbsolute(path) ? path : resolve(root, path) : root);
}
function ensureArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}
async function runParallel(maxConcurrency, source, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of source) {
    const p = Promise.resolve().then(() => iteratorFn(item, source));
    ret.push(p);
    if (maxConcurrency <= source.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}
const speRE = /[\\/]/;
function queryPublicPath(paths) {
  if (paths.length === 0) {
    return "";
  } else if (paths.length === 1) {
    return node_path.dirname(paths[0]);
  }
  let publicPath = node_path.normalize(node_path.dirname(paths[0])) + node_path.sep;
  let publicUnits = publicPath.split(speRE);
  let index = publicUnits.length - 1;
  for (const path of paths.slice(1)) {
    if (!index) {
      return publicPath;
    }
    const dirPath = node_path.normalize(node_path.dirname(path)) + node_path.sep;
    if (dirPath.startsWith(publicPath)) {
      continue;
    }
    const units = dirPath.split(speRE);
    if (units.length < index) {
      publicPath = dirPath;
      publicUnits = units;
      continue;
    }
    for (let i = 0; i <= index; ++i) {
      if (publicUnits[i] !== units[i]) {
        if (!i) {
          return "";
        }
        index = i - 1;
        publicUnits = publicUnits.slice(0, index + 1);
        publicPath = publicUnits.join(node_path.sep) + node_path.sep;
        break;
      }
    }
  }
  return publicPath.slice(0, -1);
}
function removeDirIfEmpty(dir) {
  if (!node_fs.existsSync(dir)) {
    return;
  }
  let onlyHasDir = true;
  for (const file of node_fs.readdirSync(dir)) {
    const abs = resolve(dir, file);
    if (node_fs.lstatSync(abs).isDirectory()) {
      if (!removeDirIfEmpty(abs)) {
        onlyHasDir = false;
      }
    } else {
      onlyHasDir = false;
    }
  }
  if (onlyHasDir) {
    node_fs.rmdirSync(dir);
  }
  return onlyHasDir;
}
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
function base64Encode(number) {
  if (number >= 0 && number < BASE64_ALPHABET.length) {
    return BASE64_ALPHABET[number];
  }
  throw new TypeError("Base64 integer must be between 0 and 63: " + number);
}
const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT;
const VLQ_BASE_MASK = VLQ_BASE - 1;
const VLQ_CONTINUATION_BIT = VLQ_BASE;
function toVLQSigned(number) {
  return number < 0 ? (-number << 1) + 1 : (number << 1) + 0;
}
function base64VLQEncode(numbers) {
  let encoded = "";
  for (const number of numbers) {
    let vlq = toVLQSigned(number);
    let digit;
    do {
      digit = vlq & VLQ_BASE_MASK;
      vlq >>>= VLQ_BASE_SHIFT;
      if (vlq > 0) {
        digit |= VLQ_CONTINUATION_BIT;
      }
      encoded += base64Encode(digit);
    } while (vlq > 0);
  }
  return encoded;
}
const pkgPathCache = /* @__PURE__ */ new Map();
function tryGetPkgPath(beginPath) {
  beginPath = normalizePath(beginPath);
  if (pkgPathCache.has(beginPath)) {
    return pkgPathCache.get(beginPath);
  }
  const pkgPath = resolve(beginPath, "package.json");
  if (node_fs.existsSync(pkgPath)) {
    pkgPathCache.set(beginPath, pkgPath);
    return pkgPath;
  }
  const parentDir = normalizePath(node_path.dirname(beginPath));
  if (!parentDir || parentDir === beginPath) {
    pkgPathCache.set(beginPath, void 0);
    return;
  }
  return tryGetPkgPath(parentDir);
}
function toCapitalCase(value) {
  value = value.trim().replace(/\s+/g, "-");
  value = value.replace(/-+(\w)/g, (_, char) => char ? char.toUpperCase() : "");
  return (value.charAt(0).toLocaleUpperCase() + value.slice(1)).replace(
    /[^\w]/g,
    ""
  );
}

const dtsRE$1 = /\.d\.tsx?$/;
function rollupDeclarationFiles({
  root,
  configPath,
  compilerOptions,
  outDir,
  entryPath,
  fileName,
  libFolder,
  rollupConfig = {}
}) {
  const configObjectFullPath = node_path.resolve(root, "api-extractor.json");
  if (!dtsRE$1.test(fileName)) {
    fileName += ".d.ts";
  }
  const extractorConfig = apiExtractor.ExtractorConfig.prepare({
    configObject: {
      ...rollupConfig,
      projectFolder: root,
      mainEntryPointFilePath: entryPath,
      compiler: {
        tsconfigFilePath: configPath,
        overrideTsconfig: {
          $schema: "http://json.schemastore.org/tsconfig",
          compilerOptions
        }
      },
      apiReport: {
        enabled: false,
        reportFileName: "<unscopedPackageName>.api.md",
        ...rollupConfig.apiReport
      },
      docModel: {
        enabled: false,
        ...rollupConfig.docModel
      },
      dtsRollup: {
        enabled: true,
        publicTrimmedFilePath: node_path.resolve(outDir, fileName)
      },
      tsdocMetadata: {
        enabled: false,
        ...rollupConfig.tsdocMetadata
      },
      messages: {
        compilerMessageReporting: {
          default: {
            logLevel: "none"
          }
        },
        extractorMessageReporting: {
          default: {
            logLevel: "none"
          }
        },
        ...rollupConfig.messages
      }
    },
    configObjectFullPath,
    packageJsonFullPath: tryGetPkgPath(configObjectFullPath)
  });
  const result = apiExtractor.Extractor.invoke(extractorConfig, {
    localBuild: false,
    showVerboseMessages: false,
    showDiagnostics: false,
    typescriptCompilerFolder: libFolder ? node_path.resolve(libFolder) : void 0
  });
  return result.succeeded;
}

const jsonRE = /\.json$/;
function JsonResolver() {
  return {
    name: "json",
    supports(id) {
      return jsonRE.test(id);
    },
    transform({ id, root, program }) {
      const sourceFile = program.getSourceFile(id);
      if (!sourceFile)
        return [];
      return [
        {
          path: node_path.relative(root, `${id}.d.ts`),
          content: `declare const _default: ${sourceFile.text};

export default _default;
`
        }
      ];
    }
  };
}

const svelteRE = /\.svelte$/;
function SvelteResolver() {
  return {
    name: "svelte",
    supports(id) {
      return svelteRE.test(id);
    },
    transform({ id, root }) {
      return [
        {
          path: node_path.relative(root, `${id}.d.ts`),
          content: "export { SvelteComponentTyped as default } from 'svelte';\n"
        }
      ];
    }
  };
}

const vueRE = /\.vue$/;
function VueResolver() {
  return {
    name: "vue",
    supports(id) {
      return vueRE.test(id);
    },
    transform({ id, code, program, service }) {
      const sourceFile = program.getSourceFile(id) || program.getSourceFile(id + ".ts") || program.getSourceFile(id + ".js") || program.getSourceFile(id + ".tsx") || program.getSourceFile(id + ".jsx");
      if (!sourceFile)
        return [];
      const outputs = service.getEmitOutput(sourceFile.fileName, true).outputFiles.map((file) => {
        return {
          path: file.name,
          content: file.text
        };
      });
      if (!program.getCompilerOptions().declarationMap)
        return outputs;
      const [beforeScript] = code.split(/\s*<script.*>/);
      const beforeLines = beforeScript.split("\n").length;
      for (const output of outputs) {
        if (output.path.endsWith(".map")) {
          try {
            const sourceMap = JSON.parse(output.content);
            sourceMap.sources = sourceMap.sources.map(
              (source) => source.replace(/\.vue\.ts$/, ".vue")
            );
            if (beforeScript && beforeScript !== code && beforeLines) {
              sourceMap.mappings = `${base64VLQEncode([0, 0, beforeLines, 0])};${sourceMap.mappings}`;
            }
            output.content = JSON.stringify(sourceMap);
          } catch (e) {
          }
        }
      }
      return outputs;
    }
  };
}

function parseResolvers(resolvers) {
  const nameMap = /* @__PURE__ */ new Map();
  for (const resolver of resolvers) {
    resolver.name && nameMap.set(resolver.name, resolver);
  }
  return Array.from(nameMap.values());
}

const globSuffixRE = /^((?:.*\.[^.]+)|(?:\*+))$/;
function normalizeGlob(path) {
  if (/[\\/]$/.test(path)) {
    return path + "**";
  } else if (!globSuffixRE.test(path.split(/[\\/]/).pop())) {
    return path + "/**";
  }
  return path;
}
const globalDynamicTypeRE = /import\(['"][^;\n]+?['"]\)\.\w+[.()[\]<>,;\n\s]/g;
const dynamicTypeRE = /import\(['"](.+)['"]\)\.(.+)([.()[\]<>,;\n\s])/;
const importTypesRE = /import\s?(?:type)?\s?\{(.+)\}\s?from\s?['"].+['"]/;
function transformDynamicImport(content) {
  const importMap = /* @__PURE__ */ new Map();
  const defaultMap = /* @__PURE__ */ new Map();
  let defaultCount = 1;
  content = content.replace(globalDynamicTypeRE, (str) => {
    const matchResult = str.match(dynamicTypeRE);
    const libName = matchResult[1];
    const importSet = importMap.get(libName) ?? importMap.set(libName, /* @__PURE__ */ new Set()).get(libName);
    let usedType = matchResult[2];
    if (usedType === "default") {
      usedType = defaultMap.get(libName) ?? defaultMap.set(libName, `__DTS_${defaultCount++}__`).get(libName);
      importSet.add(`default as ${usedType}`);
    } else {
      importSet.add(usedType);
    }
    return usedType + matchResult[3];
  });
  importMap.forEach((importSet, libName) => {
    const importReg = new RegExp(
      `import\\s?(?:type)?\\s?\\{[^;\\n]+\\}\\s?from\\s?['"]${libName}['"]`,
      "g"
    );
    const matchResult = content.match(importReg);
    if (matchResult?.[0]) {
      matchResult[0].match(importTypesRE)[1].trim().split(",").forEach((type) => {
        type && importSet.add(type.trim());
      });
      content = content.replace(
        matchResult[0],
        `import { ${Array.from(importSet).join(", ")} } from '${libName}'`
      );
    } else {
      content = `import { ${Array.from(importSet).join(", ")} } from '${libName}';
` + content;
    }
  });
  return content;
}
function isAliasMatch(alias, importer) {
  if (isRegExp(alias.find))
    return alias.find.test(importer);
  if (importer.length < alias.find.length)
    return false;
  if (importer === alias.find)
    return true;
  return importer.indexOf(alias.find) === 0 && (alias.find.endsWith("/") || importer.substring(alias.find.length)[0] === "/");
}
const globalImportRE = /(?:(?:import|export)\s?(?:type)?\s?(?:(?:\{[^;\n]+\})|(?:[^;\n]+))\s?from\s?['"][^;\n]+['"])|(?:import\(['"][^;\n]+?['"]\))/g;
const staticImportRE = /(?:import|export)\s?(?:type)?\s?\{?.+\}?\s?from\s?['"](.+)['"]/;
const dynamicImportRE = /import\(['"]([^;\n]+?)['"]\)/;
const simpleStaticImportRE = /((?:import|export).+from\s?)['"](.+)['"]/;
const simpleDynamicImportRE = /(import\()['"](.+)['"]\)/;
function transformAliasImport(filePath, content, aliases, exclude = []) {
  if (!aliases || !aliases.length)
    return content;
  return content.replace(globalImportRE, (str) => {
    let matchResult = str.match(staticImportRE);
    let isDynamic = false;
    if (!matchResult) {
      matchResult = str.match(dynamicImportRE);
      isDynamic = true;
    }
    if (matchResult?.[1]) {
      const matchedAlias = aliases.find((alias) => isAliasMatch(alias, matchResult[1]));
      if (matchedAlias) {
        if (exclude.some((e) => isRegExp(e) ? e.test(matchResult[1]) : String(e) === matchResult[1])) {
          return str;
        }
        const truthPath = node_path.isAbsolute(matchedAlias.replacement) ? normalizePath(node_path.relative(node_path.dirname(filePath), matchedAlias.replacement)) : normalizePath(matchedAlias.replacement);
        return str.replace(
          isDynamic ? simpleDynamicImportRE : simpleStaticImportRE,
          `$1'${matchResult[1].replace(
            matchedAlias.find,
            (truthPath.startsWith(".") ? truthPath : `./${truthPath}`) + (typeof matchedAlias.find === "string" && matchedAlias.find.endsWith("/") ? "/" : "")
          )}'${isDynamic ? ")" : ""}`
        );
      }
    }
    return str;
  });
}
const pureImportRE = /import\s?['"][^;\n]+?['"];?\n?/g;
function removePureImport(content) {
  return content.replace(pureImportRE, "");
}

const jsRE = /\.(m|c)?jsx?$/;
const tsRE = /\.(m|c)?tsx?$/;
const dtsRE = /\.d\.(m|c)?tsx?$/;
const tjsRE = /\.(m|c)?(t|j)sx?$/;
const mtjsRE = /\.m(t|j)sx?$/;
const ctjsRE = /\.c(t|j)sx?$/;
const fullRelativeRE = /^\.\.?\//;
const defaultIndex = "index.d.ts";
const logPrefix = kolorist.cyan("[vite:dts]");
const bundleDebug = debug__default("vite-plugin-dts:bundle");
const fixedCompilerOptions = {
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  noUnusedParameters: false,
  checkJs: false,
  skipLibCheck: true,
  preserveSymlinks: false,
  noEmitOnError: void 0,
  target: ts__default.ScriptTarget.ESNext
};
const noop = () => {
};
const extPrefix = (file) => mtjsRE.test(file) ? "m" : ctjsRE.test(file) ? "c" : "";
function dtsPlugin(options = {}) {
  const {
    tsconfigPath,
    logLevel,
    staticImport = false,
    clearPureImport = true,
    cleanVueFileName = false,
    insertTypesEntry = false,
    rollupTypes = false,
    pathsToAliases = true,
    aliasesExclude = [],
    copyDtsFiles = false,
    strictOutput = true,
    afterDiagnostic = noop,
    beforeWriteFile = noop,
    afterBuild = noop
  } = options;
  let root = ensureAbsolute(options.root ?? "", process.cwd());
  let publicRoot = "";
  let entryRoot = options.entryRoot ?? "";
  let configPath;
  let compilerOptions;
  let rawCompilerOptions;
  let outDirs;
  let entries;
  let include;
  let exclude;
  let aliases;
  let libName;
  let indexName;
  let logger;
  let host;
  let program;
  let filter;
  let bundled = false;
  let timeRecord = 0;
  const resolvers = parseResolvers([
    JsonResolver(),
    VueResolver(),
    SvelteResolver(),
    ...options.resolvers || []
  ]);
  const rootFiles = /* @__PURE__ */ new Set();
  const outputFiles = /* @__PURE__ */ new Map();
  const rollupConfig = { ...options.rollupConfig || {} };
  rollupConfig.bundledPackages = rollupConfig.bundledPackages || options.bundledPackages || [];
  return {
    name: "vite:dts",
    apply: "build",
    enforce: "pre",
    config(config) {
      const aliasOptions = config?.resolve?.alias ?? [];
      if (isNativeObj(aliasOptions)) {
        aliases = Object.entries(aliasOptions).map(([key, value]) => {
          return { find: key, replacement: value };
        });
      } else {
        aliases = ensureArray(aliasOptions);
      }
      if (aliasesExclude.length > 0) {
        aliases = aliases.filter(
          ({ find }) => !aliasesExclude.some(
            (aliasExclude) => aliasExclude && (isRegExp(find) ? find.toString() === aliasExclude.toString() : isRegExp(aliasExclude) ? find.match(aliasExclude)?.[0] : find === aliasExclude)
          )
        );
      }
    },
    async configResolved(config) {
      logger = logLevel ? (await import('vite')).createLogger(logLevel, { allowClearScreen: config.clearScreen }) : config.logger;
      root = ensureAbsolute(options.root ?? "", config.root);
      if (config.build.lib) {
        const input = typeof config.build.lib.entry === "string" ? [config.build.lib.entry] : config.build.lib.entry;
        if (Array.isArray(input)) {
          entries = input.reduce((prev, current) => {
            prev[node_path.basename(current)] = current;
            return prev;
          }, {});
        } else {
          entries = { ...input };
        }
        const filename = config.build.lib.fileName ?? defaultIndex;
        const entry = typeof config.build.lib.entry === "string" ? config.build.lib.entry : Object.values(config.build.lib.entry)[0];
        libName = config.build.lib.name || "_default";
        indexName = typeof filename === "string" ? filename : filename("es", entry);
        if (!dtsRE.test(indexName)) {
          indexName = `${indexName.replace(tjsRE, "")}.d.${extPrefix(indexName)}ts`;
        }
      } else {
        logger.warn(
          kolorist.yellow(
            `
${kolorist.cyan(
              "[vite:dts]"
            )} You are building a library that may not need to generate declaration files.
`
          )
        );
        libName = "_default";
        indexName = defaultIndex;
      }
      if (!options.outDir) {
        outDirs = [ensureAbsolute(config.build.outDir, root)];
      }
      bundleDebug("parse vite config");
    },
    options(options2) {
      if (entries)
        return;
      const input = typeof options2.input === "string" ? [options2.input] : options2.input;
      if (Array.isArray(input)) {
        entries = input.reduce((prev, current) => {
          prev[node_path.basename(current)] = current;
          return prev;
        }, {});
      } else {
        entries = { ...input };
      }
      logger = logger || console;
      aliases = aliases || [];
      libName = "_default";
      indexName = defaultIndex;
      bundleDebug("parse options");
    },
    async buildStart() {
      if (program)
        return;
      bundleDebug("begin buildStart");
      timeRecord = 0;
      const startTime = Date.now();
      configPath = tsconfigPath ? ensureAbsolute(tsconfigPath, root) : ts__default.findConfigFile(root, ts__default.sys.fileExists);
      const content = configPath ? languageCore.createParsedCommandLine(ts__default, ts__default.sys, configPath) : void 0;
      compilerOptions = {
        ...content?.options || {},
        ...options.compilerOptions || {},
        ...fixedCompilerOptions,
        outDir: "."
      };
      rawCompilerOptions = content?.raw.compilerOptions || {};
      if (!outDirs) {
        outDirs = options.outDir ? ensureArray(options.outDir).map((d) => ensureAbsolute(d, root)) : [ensureAbsolute(content?.raw.compilerOptions?.outDir || "dist", root)];
      }
      const { baseUrl, paths } = compilerOptions;
      if (pathsToAliases && baseUrl && paths) {
        const basePath = ensureAbsolute(baseUrl, configPath ? node_path.dirname(configPath) : root);
        const existsFinds = new Set(
          aliases.map((alias) => alias.find).filter((find) => typeof find === "string")
        );
        for (const [findWithAsterisk, replacements] of Object.entries(paths)) {
          const find = findWithAsterisk.replace("/*", "");
          if (!replacements.length || existsFinds.has(find))
            continue;
          aliases.push({
            find,
            replacement: ensureAbsolute(replacements[0].replace("/*", ""), basePath)
          });
        }
      }
      include = ensureArray(options.include ?? content?.raw.include ?? "**/*").map(normalizeGlob);
      exclude = ensureArray(options.exclude ?? content?.raw.exclude ?? "node_modules/**").map(
        normalizeGlob
      );
      filter = pluginutils.createFilter(include, exclude, { resolve: root });
      const rootNames = Object.values(entries).map((entry) => ensureAbsolute(entry, root)).concat(content?.fileNames.filter(filter) || []).map(normalizePath);
      host = ts__default.createCompilerHost(compilerOptions, true);
      program = vueTsc.createProgram({ host, rootNames, options: compilerOptions });
      libName = toCapitalCase(libName || "_default");
      indexName = indexName || defaultIndex;
      const maybeEmitted = (sourceFile) => {
        return !(compilerOptions.noEmitForJsFiles && jsRE.test(sourceFile.fileName)) && !sourceFile.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sourceFile);
      };
      publicRoot = compilerOptions.rootDir ? ensureAbsolute(compilerOptions.rootDir, root) : compilerOptions.composite && compilerOptions.configFilePath ? node_path.dirname(compilerOptions.configFilePath) : queryPublicPath(
        program.getSourceFiles().filter(maybeEmitted).map((sourceFile) => sourceFile.fileName)
      );
      publicRoot = normalizePath(publicRoot);
      entryRoot = entryRoot || publicRoot;
      entryRoot = ensureAbsolute(entryRoot, root);
      const diagnostics = program.getDeclarationDiagnostics();
      if (diagnostics?.length) {
        logger.error(ts__default.formatDiagnostics(diagnostics, host));
      }
      if (typeof afterDiagnostic === "function") {
        await wrapPromise(afterDiagnostic(diagnostics));
      }
      rootNames.forEach((file) => {
        this.addWatchFile(file);
        rootFiles.add(file);
      });
      bundleDebug("create ts program");
      timeRecord += Date.now() - startTime;
    },
    async transform(code, id) {
      let resolver;
      id = normalizePath(id);
      if (!host || !program || !filter(id) || !(resolver = resolvers.find((r) => r.supports(id))) && !tjsRE.test(id)) {
        return;
      }
      const startTime = Date.now();
      const outDir = outDirs[0];
      const service = program.__vue.languageService;
      id = id.split("?")[0];
      rootFiles.delete(id);
      if (resolver) {
        const result = await resolver.transform({
          id,
          code,
          root: publicRoot,
          outDir,
          host,
          program,
          service
        });
        for (const { path, content } of result) {
          outputFiles.set(
            resolve(publicRoot, node_path.relative(outDir, ensureAbsolute(path, outDir))),
            content
          );
        }
      } else {
        const sourceFile = program.getSourceFile(id);
        if (sourceFile) {
          for (const outputFile of service.getEmitOutput(sourceFile.fileName, true, true).outputFiles) {
            outputFiles.set(
              resolve(publicRoot, node_path.relative(outDir, ensureAbsolute(outputFile.name, outDir))),
              outputFile.text
            );
          }
        }
      }
      const dtsId = id.replace(tjsRE, "") + ".d.ts";
      const dtsSourceFile = program.getSourceFile(dtsId);
      dtsSourceFile && filter(dtsSourceFile.fileName) && outputFiles.set(normalizePath(dtsSourceFile.fileName), dtsSourceFile.getFullText());
      timeRecord += Date.now() - startTime;
    },
    watchChange(id) {
      id = normalizePath(id);
      if (!host || !program || !filter(id) || !resolvers.find((r) => r.supports(id)) && !tjsRE.test(id)) {
        return;
      }
      id = id.split("?")[0];
      const sourceFile = host.getSourceFile(id, ts__default.ScriptTarget.ESNext);
      if (sourceFile) {
        rootFiles.add(sourceFile.fileName);
        program.__vue.projectVersion++;
        bundled = false;
        timeRecord = 0;
      }
    },
    async writeBundle() {
      if (!host || !program || bundled)
        return;
      bundled = true;
      bundleDebug("begin writeBundle");
      logger.info(kolorist.green(`
${logPrefix} Start generate declaration files...`));
      const startTime = Date.now();
      const outDir = outDirs[0];
      const emittedFiles = /* @__PURE__ */ new Map();
      const writeOutput = async (path, content, outDir2, record = true) => {
        if (typeof beforeWriteFile === "function") {
          const result = await wrapPromise(beforeWriteFile(path, content));
          if (result === false)
            return;
          if (result) {
            path = result.filePath || path;
            content = result.content ?? content;
          }
        }
        path = normalizePath(path);
        const dir = normalizePath(node_path.dirname(path));
        if (strictOutput && !dir.startsWith(normalizePath(outDir2))) {
          logger.warn(`${logPrefix} ${kolorist.yellow("Outside emitted:")} ${path}`);
          return;
        }
        if (!node_fs.existsSync(dir)) {
          await promises.mkdir(dir, { recursive: true });
        }
        await promises.writeFile(path, content, "utf-8");
        record && emittedFiles.set(path, content);
      };
      const service = program.__vue.languageService;
      const sourceFiles = program.getSourceFiles();
      for (const sourceFile of sourceFiles) {
        if (!filter(sourceFile.fileName))
          continue;
        if (copyDtsFiles && dtsRE.test(sourceFile.fileName)) {
          outputFiles.set(normalizePath(sourceFile.fileName), sourceFile.getFullText());
        }
        if (rootFiles.has(sourceFile.fileName)) {
          for (const outputFile of service.getEmitOutput(sourceFile.fileName, true).outputFiles) {
            outputFiles.set(
              resolve(publicRoot, node_path.relative(outDir, ensureAbsolute(outputFile.name, outDir))),
              outputFile.text
            );
          }
          rootFiles.delete(sourceFile.fileName);
        }
      }
      bundleDebug("emit output patch");
      const currentDir = host.getCurrentDirectory();
      await runParallel(
        node_os.cpus().length,
        Array.from(outputFiles.entries()),
        async ([path, content]) => {
          const isMapFile = path.endsWith(".map");
          const baseDir = node_path.dirname(path);
          if (!isMapFile && content) {
            content = clearPureImport ? removePureImport(content) : content;
            content = transformAliasImport(path, content, aliases, aliasesExclude);
            content = staticImport || rollupTypes ? transformDynamicImport(content) : content;
          }
          path = resolve(
            outDir,
            node_path.relative(entryRoot, cleanVueFileName ? path.replace(".vue.d.ts", ".d.ts") : path)
          );
          content = cleanVueFileName ? content.replace(/['"](.+)\.vue['"]/g, '"$1"') : content;
          if (isMapFile) {
            try {
              const sourceMap = JSON.parse(content);
              sourceMap.sources = sourceMap.sources.map((source) => {
                return normalizePath(
                  node_path.relative(
                    node_path.dirname(path),
                    resolve(currentDir, node_path.relative(publicRoot, baseDir), source)
                  )
                );
              });
              content = JSON.stringify(sourceMap);
            } catch (e) {
              logger.warn(`${logPrefix} ${kolorist.yellow("Processing source map fail:")} ${path}`);
            }
          }
          await writeOutput(path, content, outDir);
        }
      );
      bundleDebug("write output");
      if (insertTypesEntry || rollupTypes) {
        const pkgPath = tryGetPkgPath(root);
        let pkg;
        try {
          pkg = pkgPath && node_fs.existsSync(pkgPath) ? JSON.parse(await promises.readFile(pkgPath, "utf-8")) : {};
        } catch (e) {
        }
        const entryNames = Object.keys(entries);
        const types = pkg.types || pkg.typings || pkg.publishConfig?.types || pkg.publishConfig?.typings || (pkg.exports?.["."] || pkg.exports?.["./"])?.types;
        const multiple = entryNames.length > 1;
        const typesPath = types ? resolve(root, types) : resolve(outDir, indexName);
        for (const name of entryNames) {
          const path = multiple ? resolve(outDir, `${name.replace(tsRE, "")}.d.ts`) : typesPath;
          if (node_fs.existsSync(path))
            continue;
          const index = resolve(
            outDir,
            node_path.relative(entryRoot, `${entries[name].replace(tsRE, "")}.d.ts`)
          );
          let fromPath = normalizePath(node_path.relative(node_path.dirname(path), index));
          fromPath = fromPath.replace(dtsRE, "");
          fromPath = fullRelativeRE.test(fromPath) ? fromPath : `./${fromPath}`;
          let content = `export * from '${fromPath}'
`;
          if (node_fs.existsSync(index)) {
            const entryCodes = await promises.readFile(index, "utf-8");
            if (entryCodes.includes("export default")) {
              content += `import ${libName} from '${fromPath}'
export default ${libName}
`;
            }
          }
          await writeOutput(path, content, outDir);
        }
        bundleDebug("insert index");
        if (rollupTypes) {
          logger.info(kolorist.green(`${logPrefix} Start rollup declaration files...`));
          let libFolder = resolve(root, "node_modules/typescript");
          if (!node_fs.existsSync(libFolder)) {
            if (root !== entryRoot) {
              libFolder = resolve(entryRoot, "node_modules/typescript");
              if (!node_fs.existsSync(libFolder))
                libFolder = void 0;
            }
            libFolder = void 0;
          }
          const rollupFiles = /* @__PURE__ */ new Set();
          if (multiple) {
            for (const name of entryNames) {
              const path = resolve(outDir, `${name.replace(tsRE, "")}.d.ts`);
              rollupDeclarationFiles({
                root,
                configPath,
                compilerOptions: rawCompilerOptions,
                outDir,
                entryPath: path,
                fileName: node_path.basename(path),
                libFolder,
                rollupConfig
              });
              emittedFiles.delete(path);
              rollupFiles.add(path);
            }
          } else {
            rollupDeclarationFiles({
              root,
              configPath,
              compilerOptions: rawCompilerOptions,
              outDir,
              entryPath: typesPath,
              fileName: node_path.basename(typesPath),
              libFolder,
              rollupConfig
            });
            emittedFiles.delete(typesPath);
            rollupFiles.add(typesPath);
          }
          await runParallel(node_os.cpus().length, Array.from(emittedFiles.keys()), (f) => promises.unlink(f));
          removeDirIfEmpty(outDir);
          emittedFiles.clear();
          for (const file of rollupFiles) {
            emittedFiles.set(file, await promises.readFile(file, "utf-8"));
          }
          bundleDebug("rollup output");
        }
      }
      if (outDirs.length > 1) {
        const extraOutDirs = outDirs.slice(1);
        await runParallel(node_os.cpus().length, Array.from(emittedFiles), async ([wroteFile, content]) => {
          const relativePath = node_path.relative(outDir, wroteFile);
          await Promise.all(
            extraOutDirs.map(async (targetOutDir) => {
              const path = resolve(targetOutDir, relativePath);
              if (wroteFile.endsWith(".map")) {
                const relativeOutDir = node_path.relative(outDir, targetOutDir);
                if (relativeOutDir) {
                  try {
                    const sourceMap = JSON.parse(content);
                    sourceMap.sources = sourceMap.sources.map((source) => {
                      return normalizePath(node_path.relative(relativeOutDir, source));
                    });
                    content = JSON.stringify(sourceMap);
                  } catch (e) {
                    logger.warn(`${logPrefix} ${kolorist.yellow("Processing source map fail:")} ${path}`);
                  }
                }
              }
              await writeOutput(path, content, targetOutDir, false);
            })
          );
        });
      }
      if (typeof afterBuild === "function") {
        await wrapPromise(afterBuild());
      }
      bundleDebug("finish");
      logger.info(
        kolorist.green(`${logPrefix} Declaration files built in ${timeRecord + Date.now() - startTime}ms.
`)
      );
    }
  };
}

module.exports = dtsPlugin;
