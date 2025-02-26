const { join, dirname, basename } = require("path");
const { toUpper, snakeCase, isEqual } = require("lodash");
const prettier = require("prettier");
const ast = require("@textlint/markdown-to-ast");
const inject = require("md-node-inject");
const toMarkdown = require("ast-to-markdown");
const {
  readdirSync,
  ensureDirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  existsSync,
} = require("fs-extra");
const { Project, ts } = require("ts-morph");
const rimraf = require("rimraf");
const chalk = require("chalk");
const log = require("../log");

/**
 * Converts ./path/to/file.js to ./path/to
 * @param {string} dir
 */
function resolveDir(dir) {
  if (!/\.(t|j)s$/.test(dir)) {
    return dir;
  }
  return dirname(dir);
}

/**
 * @param {string} rootPath
 */
function getPackage(rootPath) {
  // eslint-disable-next-line import/no-dynamic-require
  return require(join(rootPath, "package.json"));
}

/**
 * @param {string} rootPath
 */
function getModuleDir(rootPath) {
  const pkg = getPackage(rootPath);
  try {
    return resolveDir(pkg.module);
  } catch (e) {
    // resolveDir will throw an error if pkg.module doesn't exist
    // we just return false here.
    return false;
  }
}

/**
 * @param {string} rootPath
 */
function getUnpkgDir(rootPath) {
  const pkg = getPackage(rootPath);
  try {
    return resolveDir(pkg.unpkg);
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} rootPath
 */
function getTypesDir(rootPath) {
  const pkg = getPackage(rootPath);
  try {
    return resolveDir(pkg.types || pkg.typings);
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} rootPath
 */
function getMainDir(rootPath) {
  const { main } = getPackage(rootPath);
  return resolveDir(main);
}

/**
 * @param {string} path
 */
function removeExt(path) {
  return path.replace(/\.[^.]+$/, "");
}

/**
 * @param {string} path
 * @param {number} index
 * @param {string[]} array
 */
function isRootModule(path, index, array) {
  const rootPath = path.replace(/^([^/]+).*$/, "$1");
  return path === rootPath || !array.includes(rootPath);
}

/**
 * Filters out /dist, /es, /lib, /ts etc.
 * @param {string} rootPath
 * @param {string} filename
 */
function isSourceModule(rootPath, filename) {
  const dists = [
    getModuleDir(rootPath),
    getUnpkgDir(rootPath),
    getTypesDir(rootPath),
    getMainDir(rootPath),
  ];
  return !dists.includes(filename);
}

/**
 * @param {string} path
 */
function isDirectory(path) {
  return lstatSync(path).isDirectory();
}

/**
 * @param {string} rootPath
 */
function getSourcePath(rootPath) {
  return join(rootPath, "src");
}

/**
 * Ensure that paths are consistent across Windows and non-Windows platforms.
 * @param {string} filePath
 */
function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

/**
 * Filters out files starting with __
 * Includes directories and TS/JS files.
 * @param {string} rootPath
 * @param {string} filename
 */
function isPublicModule(rootPath, filename) {
  const isPrivate = /^__/.test(filename);
  if (isPrivate) {
    return false;
  }
  if (isDirectory(join(rootPath, filename))) {
    return true;
  }
  return /\.(j|t)sx?$/.test(filename);
}

/**
 * Returns { index: "path/to/index", moduleName: "path/to/moduleName" }
 * @param {string} rootPath
 * @param {string} prefix
 */
function getPublicFiles(rootPath, prefix = "") {
  return readdirSync(rootPath)
    .filter((filename) => isPublicModule(rootPath, filename))
    .sort() // Ensure consistent order across platforms
    .reduce((acc, filename) => {
      const path = join(rootPath, filename);
      const childFiles =
        isDirectory(path) && getPublicFiles(path, join(prefix, filename));
      return {
        ...(childFiles || {
          [removeExt(normalizePath(join(prefix, filename)))]: normalizePath(
            path
          ),
        }),
        ...acc,
      };
    }, {});
}

/**
 * Returns the same as getPublicFiles, but grouped by modules.
 * Like { "path/to/moduleName": ["path/to/moduleName/file1", "path/to/moduleName/file2"] }
 * @param {string} rootPath
 */
function getPublicFilesByModules(rootPath) {
  const publicFiles = getPublicFiles(rootPath);
  return Object.values(publicFiles).reduce((acc, path) => {
    const moduleName = dirname(path);
    acc[moduleName] = [...(acc[moduleName] || []), path];
    return acc;
  }, {});
}

/**
 * Returns ["module", "path/to/module", ...]
 * @param {string} rootPath
 */
function getProxyFolders(rootPath) {
  const publicFiles = getPublicFiles(getSourcePath(rootPath));
  return Object.keys(publicFiles)
    .map((name) => name.replace(/\/index$/, ""))
    .filter((name) => name !== "index");
}

/**
 * Returns ["lib", "es", "dist", "ts", "moduleName", ...]
 * @param {string} rootPath
 */
function getBuildFolders(rootPath) {
  return [
    getMainDir(rootPath),
    getUnpkgDir(rootPath),
    getModuleDir(rootPath),
    getTypesDir(rootPath),
    ...getProxyFolders(rootPath),
  ].filter(Boolean);
}

/**
 * @param {string} rootPath
 */
function cleanBuild(rootPath) {
  const pkg = getPackage(rootPath);
  const cleaned = [];
  getBuildFolders(rootPath)
    .filter(isRootModule)
    .forEach((name) => {
      rimraf.sync(name);
      cleaned.push(chalk.bold(chalk.gray(name)));
    });
  if (cleaned.length) {
    log(
      ["", `Cleaned in ${chalk.bold(pkg.name)}:`, `${cleaned.join(", ")}`].join(
        "\n"
      )
    );
  }
}

/**
 * @param {string} path
 */
function getIndexPath(path) {
  return join(
    path,
    readdirSync(path).find((file) => /^index\.(j|t)sx?/.test(file))
  );
}

/**
 * @param {string} rootPath
 */
function makeGitignore(rootPath) {
  const pkg = getPackage(rootPath);
  const buildFolders = getBuildFolders(rootPath);
  const contents = buildFolders
    .filter(isRootModule)
    .sort() // Ensure that the order is consistent across platforms
    .map((name) => `/${name}`)
    .join("\n");
  writeFileSync(
    join(rootPath, ".gitignore"),
    `# Automatically generated\n${contents}\n`
  );
  log(
    `\nCreated in ${chalk.bold(pkg.name)}: ${chalk.bold(
      chalk.green(".gitignore")
    )}`
  );
}

/**
 * @param {string} rootPath
 */
function makePlaygroundDeps(rootPath) {
  let { name } = getPackage(rootPath);
  name = name.split("/")[1] || name;
  const playPath = join(__dirname, "../../packages/reakit-playground");
  const playDepsPath = join(getSourcePath(playPath), "__deps");
  const buildFolders = getBuildFolders(rootPath);
  const objectContents = buildFolders
    .filter((filename) => isSourceModule(rootPath, filename))
    .sort() // Ensure that the order is consistent across platforms
    .reduce(
      (acc, folder) =>
        `${acc},\n  "${normalizePath(
          join(name, folder)
        )}": require("${normalizePath(join(name, folder))}")`,
      `  "${name}": require("${name}")`
    );
  const contents = `/* eslint-disable */
// Automatically generated
export default {
${objectContents}
};
`;
  ensureDirSync(playDepsPath);
  writeFileSync(join(playDepsPath, `${name}.ts`), contents);
  log(
    `\nCreated in ${chalk.bold("reakit-playground")}: ${chalk.bold(
      chalk.green(`__deps/${name}.ts`)
    )}`
  );
}

/**
 * @param {string} rootPath
 * @param {string} moduleName
 */
function getProxyPackageContents(rootPath, moduleName) {
  const { name } = getPackage(rootPath);
  const mainDir = getMainDir(rootPath);
  const moduleDir = getModuleDir(rootPath);
  const typesDir = getTypesDir(rootPath);
  const prefix = "../".repeat(moduleName.split("/").length);
  const json = {
    name: `${name}/${moduleName}`,
    private: true,
    sideEffects: false,
    main: join(prefix, mainDir, moduleName),
    ...(moduleDir ? { module: join(prefix, moduleDir, moduleName) } : {}),
    ...(typesDir ? { types: join(prefix, typesDir, moduleName) } : {}),
  };
  return JSON.stringify(json, null, 2);
}

/**
 * @param {string} rootPath
 */
function makeProxies(rootPath) {
  const pkg = getPackage(rootPath);
  const created = [];
  getProxyFolders(rootPath).forEach((name) => {
    ensureDirSync(name);
    writeFileSync(
      `${name}/package.json`,
      getProxyPackageContents(rootPath, name)
    );
    created.push(chalk.bold(chalk.green(name)));
  });
  if (created.length) {
    log(
      [
        "",
        `Created proxies in ${chalk.bold(pkg.name)}:`,
        `${created.join(", ")}`,
      ].join("\n")
    );
  }
}

/**
 * @param {string} rootPath
 */
function hasTSConfig(rootPath) {
  return existsSync(join(rootPath, "tsconfig.json"));
}

/**
 * @param {string} rootPath
 */
function makeTSConfigProd(rootPath) {
  const filepath = join(rootPath, "tsconfig.json");
  const contents = readFileSync(filepath);
  const json = JSON.parse(contents);
  json.extends = json.extends.replace("tsconfig.json", "tsconfig.prod.json");
  json.exclude = [...(json.exlcude || []), "src/**/__*"];
  writeFileSync(filepath, JSON.stringify(json, null, 2));
  return function restoreTSConfig() {
    writeFileSync(filepath, contents);
  };
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function getEscapedName(node) {
  const symbol = node.getSymbol();
  return symbol && symbol.getEscapedName();
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function isStateReturnDeclaration(node) {
  const kindName = node.getKindName();
  const escapedName = getEscapedName(node);
  return (
    kindName === "TypeAliasDeclaration" && /.+StateReturn$/.test(escapedName)
  );
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function isInitialStateDeclaration(node) {
  const kindName = node.getKindName();
  const escapedName = getEscapedName(node);
  return (
    kindName === "TypeAliasDeclaration" && /.+InitialState$/.test(escapedName)
  );
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function isOptionsDeclaration(node) {
  const kindName = node.getKindName();
  const escapedName = getEscapedName(node);
  return kindName === "TypeAliasDeclaration" && /.+Options$/.test(escapedName);
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function isPropsDeclaration(node) {
  return isOptionsDeclaration(node) || isInitialStateDeclaration(node);
}

/**
 * @param {import("ts-morph").Node<Node>} node
 */
function getModuleName(node) {
  return getEscapedName(node)
    .replace("unstable_", "")
    .replace(/^(.+)InitialState$/, "use$1State")
    .replace(/^(.+)StateReturn$/, "$1State")
    .replace("Options", "");
}

/**
 * @param {import("ts-morph").Symbol} symbol
 */
function getDeclaration(symbol) {
  const declarations = symbol.getDeclarations();
  return declarations[0];
}

/**
 * @param {import("ts-morph").Symbol} symbol
 */
function getJsDocs(symbol) {
  const jsDocs = getDeclaration(symbol).getJsDocs();
  return jsDocs[jsDocs.length - 1];
}

/**
 * @param {import("ts-morph").Symbol} symbol
 * @returns {string}
 */
function getComment(symbol) {
  const jsDocs = getJsDocs(symbol);
  if (!jsDocs) return "";
  return jsDocs.getDescription().trim();
}

/**
 * @param {import("ts-morph").Symbol} prop
 * @returns {string[]}
 */
function getTagNames(prop) {
  const jsDocs = getJsDocs(prop);
  if (!jsDocs) return [];
  // Object.getOwnPropertyNames(Object.getPrototypeOf(jsDocs));
  return jsDocs.getTags().map((tag) => tag.getKindName());
}

/**
 * @param {import("ts-morph").Node<Node>} node
 * @param {boolean} includePrivate
 */
function getProps(node, includePrivate) {
  const props = node.getType().getProperties();
  if (includePrivate) {
    return props;
  }
  return props.filter((prop) => !getTagNames(prop).includes("JSDocPrivateTag"));
}

/**
 * @param {import("ts-morph").Node<Node>} node
 * @param {boolean} includePrivate
 */
function getPropsNames(node, includePrivate) {
  return getProps(node, includePrivate).map((prop) => prop.getEscapedName());
}

/**
 * @param {string} rootPath
 * @param {import("ts-morph").Symbol} prop
 */
function getPropType(rootPath, prop) {
  const declaration = getDeclaration(prop);
  const type = declaration
    .getType()
    .getText(undefined, ts.TypeFormatFlags.InTypeAlias);

  const encode = (text) =>
    text.replace(/[\u00A0-\u9999<>&"]/gim, (i) => `&#${i.charCodeAt(0)};`);

  if (type.length > 50) {
    return `<code title="${encode(type)}">${encode(
      type.substring(0, 47)
    )}...</code>`;
  }
  return `<code>${encode(type)}</code>`;
}

/**
 * @param {string} rootPath
 */
function getReadmePaths(rootPath) {
  const publicFiles = getPublicFiles(getSourcePath(rootPath));
  const readmePaths = Object.values(publicFiles).reduce((acc, filePath) => {
    const readmePath = join(dirname(filePath), "README.md");
    if (!acc.includes(readmePath) && existsSync(readmePath)) {
      return [...acc, readmePath];
    }
    return acc;
  }, []);
  return readmePaths;
}

/**
 * @param {string} rootPath
 * @param {import("ts-morph").Symbol} prop
 */
function createPropTypeObject(rootPath, prop) {
  return {
    name: prop.getEscapedName(),
    description: getComment(prop),
    type: getPropType(rootPath, prop),
  };
}

/**
 * @param {string} rootPath
 * @param {import("ts-morph").Node<Node>} node
 */
function createPropTypeObjects(rootPath, node) {
  return getProps(node).map((prop) => createPropTypeObject(rootPath, prop));
}

/**
 * @param {import("ts-morph").SourceFile[]} sourceFiles
 */
function sortSourceFiles(sourceFiles) {
  return sourceFiles.sort((a, b) => {
    const aName = a.getBaseNameWithoutExtension();
    const bName = b.getBaseNameWithoutExtension();
    if (/State/.test(aName)) return -1;
    if (/State/.test(bName) || aName > bName) return 1;
    if (aName < bName) return -1;
    return 0;
  });
}

/**
 * @param {ReturnType<typeof createPropTypeObject>} prop
 */
function getPropTypesRow(prop) {
  const symbol = /unstable_/.test(prop.name)
    ? ' <span title="Experimental">⚠️</span>'
    : "";
  const name = `**\`${prop.name}\`**${symbol}`;

  return `- ${name}
  ${prop.type}

  ${prop.description.split("\n\n").join("\n\n  ")}
`;
}

/**
 * @param {Record<string, ReturnType<typeof createPropTypeObject>>} types
 */
function getPropTypesMarkdown(types) {
  const content = Object.keys(types)
    .map((title) => {
      const props = types[title];
      const rows = props.map(getPropTypesRow).join("\n");
      const stateProps = props.stateProps || [];
      const hiddenRows = stateProps.length
        ? `
<details><summary>${stateProps.length} state props</summary>

> These props are returned by the state hook. You can spread them into this component (\`{...state}\`) or pass them separately. You can also provide these props from your own state logic.

${stateProps.map(getPropTypesRow).join("\n")}
</details>`
        : "";

      return `
### \`${title}\`

${rows || (hiddenRows ? "" : "No props to show")}
${hiddenRows}`;
    })
    .join("\n\n");

  return `
<!-- Automatically generated -->

${content}`;
}

/**
 * Inject prop types tables into README.md files
 * @param {string} rootPath
 */
function injectPropTypes(rootPath) {
  const pkg = getPackage(rootPath);
  const readmePaths = getReadmePaths(rootPath);
  const stateTypes = [];
  const created = [];

  const project = new Project({
    tsConfigFilePath: join(rootPath, "tsconfig.json"),
    addFilesFromTsConfig: false,
  });

  readmePaths.forEach((readmePath) => {
    const mdContents = readFileSync(readmePath, { encoding: "utf-8" });

    if (/#\s?Props/.test(mdContents)) {
      const dir = dirname(readmePath);
      const tree = ast.parse(mdContents);
      const publicPaths = Object.values(getPublicFiles(dir));
      const sourceFiles = project.addSourceFilesAtPaths(publicPaths);
      project.resolveSourceFileDependencies();
      const types = {};

      sortSourceFiles(sourceFiles).forEach((sourceFile) => {
        sourceFile.forEachChild((node) => {
          if (isStateReturnDeclaration(node)) {
            const propTypes = createPropTypeObjects(rootPath, node);
            stateTypes.push(...propTypes.map((prop) => prop.name));
          }
          if (isPropsDeclaration(node)) {
            const moduleName = getModuleName(node);
            const propTypes = createPropTypeObjects(rootPath, node);

            if (isInitialStateDeclaration(node)) {
              types[moduleName] = propTypes;
            } else {
              const propTypesWithoutState = propTypes.filter(
                (prop) => !stateTypes.includes(prop.name)
              );
              const propTypesReturnedByState = propTypes.filter((prop) =>
                stateTypes.includes(prop.name)
              );
              types[moduleName] = propTypesWithoutState;
              types[moduleName].stateProps = propTypesReturnedByState;
            }
          }
        });
      });

      const propTypesMarkdown = getPropTypesMarkdown(types);
      try {
        const merged = inject("Props", tree, ast.parse(propTypesMarkdown));
        const markdown = toMarkdown(merged).trimLeft();
        writeFileSync(readmePath, markdown);
        created.push(chalk.bold(chalk.green(basename(dir))));
      } catch (e) {
        // do nothing
      }
    }
  });

  if (created.length) {
    log(
      [
        "",
        `Injected prop types in ${chalk.bold(pkg.name)}:`,
        `${created.join(", ")}`,
      ].join("\n")
    );
  }
}

/**
 * @param {import("ts-morph").Node<Node>} node
 * @return {import("ts-morph").Node<Node>|null}
 */
function getLiteralNode(node) {
  if (node.getKindName() === "TypeLiteral") {
    return node;
  }
  const children = node.getChildren();
  for (const child of children) {
    const result = getLiteralNode(child);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * @param {string} moduleName
 */
function getKeysName(moduleName) {
  return `${toUpper(snakeCase(moduleName))}_KEYS`;
}

/**
 * @param {any[]} a
 * @param {any[]} b
 */
function isSubsetOf(a, b) {
  return a.length && b.length && a.every((item) => b.includes(item));
}

/**
 * @param {Object} object
 */
function sortStateSets(object) {
  return Object.entries(object)
    .sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey.endsWith("State") && bKey.endsWith("State")) {
        if (isSubsetOf(aValue, bValue)) return -1;
        if (isSubsetOf(bValue, aValue)) return 1;
      }
      return 0;
    })
    .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
}

/**
 * @param {Object} object
 */
function replaceSubsetInObject(object) {
  const finalObj = {};
  Object.entries(object).forEach(([key, array]) => {
    const refs = Object.entries(finalObj)
      .filter(([, items]) => isSubsetOf(items, array))
      .map(([k]) => k);

    finalObj[key] = [
      ...refs.map((ref) => `...${getKeysName(ref)}`),
      ...array.filter(
        (item) => !refs.some((ref) => object[ref].includes(item))
      ),
    ];
  });
  if (!isEqual(object, finalObj)) {
    return replaceSubsetInObject(finalObj);
  }
  return finalObj;
}

/**
 * @param {string} acc
 * @param {[string, string[]]} entry
 */
function reduceKeys(acc, [moduleName, array]) {
  const declaration = `const ${getKeysName(moduleName)}`;
  const value = `${JSON.stringify(array)} as const`
    // "...FOO_KEYS" -> ...FOO_KEYS (without quotes)
    .replace(/"([.A-Z_]+)"/g, "$1")
    // [...FOO_KEYS] as const -> FOO_KEYS
    .replace(/\[\.\.\.([A-Z_]+)\] as const/g, "$1");

  const finalString = `${declaration} = ${value};\n`;

  if (!moduleName.endsWith("State")) {
    return `${acc}export ${finalString}`;
  }
  return `${acc}${finalString}`;
}

/**
 * Create __keys.json files
 * @param {string} rootPath
 */
function makeKeys(rootPath) {
  const pkg = getPackage(rootPath);
  if (pkg.name !== "reakit") return;

  const filesByModules = getPublicFilesByModules(getSourcePath(rootPath));
  const project = new Project({
    tsConfigFilePath: join(rootPath, "tsconfig.json"),
    addFilesFromTsConfig: false,
  });
  const created = [];

  Object.entries(filesByModules).forEach(([modulePath, paths]) => {
    const sourceFiles = project.addSourceFilesAtPaths(paths);
    const keys = {};
    const stateKeys = [];

    sortSourceFiles(sourceFiles).forEach((sourceFile) => {
      sourceFile.forEachChild((node) => {
        if (isStateReturnDeclaration(node) || isOptionsDeclaration(node)) {
          const literalNode = isOptionsDeclaration(node)
            ? getLiteralNode(node)
            : node;
          const props = literalNode ? getPropsNames(literalNode, true) : [];
          if (isStateReturnDeclaration(node)) {
            for (const prop of props) {
              if (!stateKeys.includes(prop)) {
                stateKeys.push(prop);
              }
            }
            keys[getModuleName(node)] = props;
          } else {
            keys[getModuleName(node)] = [...stateKeys, ...props];
          }
        }
      });
    });

    if (!Object.keys(keys).length) return;

    const normalizedKeys = replaceSubsetInObject(sortStateSets(keys));
    const contents = Object.entries(normalizedKeys).reduce(reduceKeys, "");
    created.push(chalk.bold(chalk.green(basename(modulePath))));

    writeFileSync(
      join(modulePath, "__keys.ts"),
      prettier.format(`// Automatically generated\n${contents}`, {
        parser: "babel-ts",
      })
    );
  });

  if (created.length) {
    log(
      [
        "",
        `Generated keys in ${chalk.bold(pkg.name)}:`,
        `${created.join(", ")}`,
      ].join("\n")
    );
  }
}

/**
 * @param {Function} callback
 */
function onExit(callback) {
  process.on("exit", callback);
  process.on("SIGINT", callback);
  process.on("SIGUSR1", callback);
  process.on("SIGUSR2", callback);
  process.on("uncaughtException", callback);
}

module.exports = {
  getPackage,
  getModuleDir,
  getUnpkgDir,
  getTypesDir,
  getMainDir,
  getSourcePath,
  getPublicFiles,
  getProxyFolders,
  getBuildFolders,
  cleanBuild,
  getIndexPath,
  makeGitignore,
  makePlaygroundDeps,
  makeProxies,
  hasTSConfig,
  makeTSConfigProd,
  injectPropTypes,
  makeKeys,
  onExit,
};
