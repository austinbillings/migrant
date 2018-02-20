const fs = require('fs');
const zaq = require('zaq');
const path = require('path');
const chalk = require('chalk');
const { createHash } = require('crypto');

const IMAGE_TYPES = [ 'jpg', 'jpeg', 'png', 'gif', 'ico', 'svg', 'tiff' ];
const TEXT_TYPES = [ 'txt', 'css', 'md', 'scss', 'less', 'sass', 'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'class', 'java', 'xml', 'json', 'sh', 'yaml', 'tag', 'jsp' ];
const RESOLVE_EXTENSIONS = [ '.js', '.jsx', '.ts', '.tsx' ];
const IMPORT_PATH_PATTERN = /import (?:{? ?(?:\*|[a-zA-Z0-9_]+)(?:\sas\s[a-zA-Z0-9]+)?,? ?}?,?)*(?:'|")([a-zA-Z0-9./\-_]*)(?:'|");?/g;


function getFileHash (path) {
  if (!fileExists(path))
    throw new TypeError(`Invalid file path provided, can't hash: ${path}`);
  if (dirExists(path))
    throw new TypeError(`Invalid file path provided; received dir. Can't hash: ${path}`);

  const data = fs.readFileSync(path, 'utf-8');
  const hash = createHash('md5')
    .update(data)
    .digest("hex");
  return hash;
}

function fileExists (path) {
	let exists = false;
	try {
		const stats = fs.statSync(path);
		exists = true;
	} catch (e) {}
	return exists;
}

function dirExists (path) {
	let exists = false;
	try {
		const stats = fs.statSync(path);
		return stats.isDirectory();
	} catch (e) {}
	return exists;
}

function isImageExtension (extension) {
  return IMAGE_TYPES.includes(extension.toLowerCase());
}

function mapDirectory (dir, { ignore = [], rootDir = '/' } = {}) {
  if (!dirExists(dir)) return null;
  return fs.readdirSync(dir)
    .filter(name => !ignore.includes(name))
    .map(name => {
      const fullUri = path.join(dir, name);
      const uri = path.relative(rootDir, fullUri);
      const stats = fs.statSync(fullUri);
      const { size } = stats;
      const isDir = stats.isDirectory();
      const type = isDir ? 'directory' : 'file';
      const output = { name, uri, type};
      if (isDir) {
        output.content = mapDirectory(fullUri, { ignore, rootDir });
      } else {
        output.extension = path.extname(name).substring(1);
        output.hash = getFileHash(fullUri);
        output.filename = path.parse(name).name;
        if (TEXT_TYPES.includes(output.extension))
          output.content = fs.readFileSync(fullUri, 'utf-8');
      }
      return output;
    });
}

function flattenMap (structure = []) {
  let layer = [...structure];
  while (layer.some(isParentStructure)) {
    layer = layer.reduce((itemSet, item) => {
      if (item.type !== 'directory') {
        return [ ...itemSet, item ];
      } else {
        const { content } = item;
        if (Array.isArray(content) && content.every(item => typeof item === 'object')) {
          const additionals = flattenMap(content);
          item.content = content
            .filter(({ hash }) => hash)
            .map(({ hash }) => hash);
          return [ ...itemSet, item, ...additionals ];
        } else {
          return [ ...itemSet ];
        }
      }
    }, []);
  };
  return layer;
}

function isValidList (list) {
  return Array.isArray(list) && list.every(item => typeof item === 'object');
}

function filterDirectories (list) {
  if (!isValidList(list))
    throw new TypeError(`Invalid list provided to filterDirectories: ${list.toString()}`);
  return list.filter(({ type }) => type !== 'directory');
}

function transformToHashList (list) {
  if (!isValidList(list))
    throw new TypeError(`Invalid list provided to transformToHashList: ${list.toString()}`);
  return list.filter(({ hash }) => hash).map(({ hash }) => hash);
}

function transformToFilenameList (list) {
  if (!isValidList(list))
    throw new TypeError(`Invalid list provided to transformToFilenameList: ${list}`);
  return list.map(({ name }) => name);
}

function getListIntersection (listA, listB) {
  return listA.filter(item => listB.includes(item));
}

function getListUniques (listA, listB) {
  return listA.filter(item => !listB.includes(item));
}

function findFileByHash (list, _hash) {
  return list.find(({ hash }) => hash === _hash);
}

function findFileByFilename (list, _name) {
  return list.find(({ name }) => name === _name);
}

function findFileByUri (list, _uri, strict = true) {
  return strict
    ? list.find(({ uri }) => uri === _uri)
    : list.find(({ uri }) => uri.indexOf(_uri) === 0)
}

function filenameHasExtension (filename, extension) {
  if (typeof filename !== 'string' || typeof extension !== 'string') return false;
  const lastIndex = filename.lastIndexOf(extension);
  return lastIndex !== -1 && (lastIndex + extension.length === filename.length);
}

function getResolvedShortName (filename) {
  let output = filename;
  if (typeof filename === 'string') {
    RESOLVE_EXTENSIONS.forEach(extension => {
      if (filenameHasExtension(filename, extension))
        output = filename.substring(0, filename.length - extension.length);
    });
  }
  return output;
}

function getCommonFilesByHash (fromList, toList) {
  const files = getCommonFiles(transformToHashList, fromList, toList);
  return files.map(hash => {
    const fromFile = findFileByHash(fromList, hash);
    const toFile = findFileByHash(toList, hash);
    return getMigrantFileStats(fromFile, toFile);
  });
}

function getPatternMatches (source, pattern) {
  if (!source || typeof source !== 'string')
    throw new TypeError(`Bad source given to getPatternMatches (${source.toString()})`);
  if (!pattern || !pattern instanceof RegExp)
    throw new TypeError(`Bad pattern given to getPatternMatches (${pattern.toString()})`);
  let match;
  const output = [];
  while ((match = pattern.exec(source)) !== null) {
    output.push({ match, index: match.index });
  };
  return output;
}

function extractFileReferences (fileContent) {
  if (!fileContent || typeof fileContent !== 'string')
    throw new TypeError(`Bad fileContent given to extractFileReferences: ${fileContent}`);
  const references = getPatternMatches(fileContent, IMPORT_PATH_PATTERN)
    .map(({ match, index }) => {
      const [ fullMatch, fileReference ] = match;
      const matchPos = fullMatch.lastIndexOf(fileReference);
      const start = index + matchPos;
      const end = start + fileReference.length;
      return { match: fileReference, start, end };
    });
  return references;
}

function applyTextChanges (text, changeList) {
  let offset = 0;
  return changeList.reduce((content, change) => {
    const { original, replacement, start, end } = change;
    const lengthDifference = replacement.length - original.length;
    const offsetStart = start + offset;
    const offsetEnd = end + offset;
    content = content.substring(0, offsetStart) + replacement + content.substring(offsetEnd);
    offset += lengthDifference;
    return content;
  }, text);
}

function sortFileReferences (referenceObjectList) {
  if (!Array.isArray(referenceObjectList))
    throw new TypeError(`Bad referenceObjectList passed to sortFileReferences: ${referenceObjectList}`);
  const references = { relative: [], libraries: [], absolute: [] };
  referenceObjectList
    .filter(({ match }) => match.indexOf('node_modules') === -1)
    .forEach(reference => {
      if (reference.match.indexOf('.') === -1 && reference.match.indexOf('/'))
        references.libraries.push(reference);
      else if (reference.match.indexOf('.') === 0)
        references.relative.push(reference);
      else
        references.absolute.push(reference);
    });
  return references;
}

function diverge (list, predicate) {
  if (!Array.isArray(list))
    throw new TypeError(`Invalid list given to #diverge(): ${list.toString()}`);
  else if (typeof predicate !== 'function')
    throw new TypeError(`Invalid predicate fn given to #diverge(): ${predicate.toString()}`);
  const matches = [];
  const rejects = [];
  list.forEach(item => (predicate(item) ? matches : rejects).push(item));
  return [ matches, rejects ];
}

function generateObject (properties, defaultValue = null) {
  const output = {};
  if (!Array.isArray(properties)) return output;
  if (typeof defaultValue === 'function') defaultValue = defaultValue();
  properties.forEach(prop => output[prop] = defaultValue);
  return output;
}

function getMigrantFileStats (fromFile, toFile) {
  const modified = (toFile.hash !== fromFile.hash);
  const migrated = (toFile.uri !== fromFile.uri);
  return {
    modified,
    migrated,
    type: toFile.type,
    name: toFile.name,
    toPath: toFile.uri,
    toHash: toFile.hash,
    toContent: toFile.content,
    fromPath: fromFile.uri,
    fromHash: fromFile.hash,
    fromContent: fromFile.content,
  };
}

function getCommonFilesByFilename (fromList, toList) {
  const [ uniqueFromFiles, uniqueToFiles ] = [fromList, toList].map(getOnlyUniqueFilenames);
  const shared = getCommonFiles(transformToFilenameList, uniqueFromFiles, uniqueToFiles);
  return shared
    .map(filename => {
      const fromFile = findFileByFilename(fromList, filename);
      const toFile = findFileByFilename(toList, filename);
      return getMigrantFileStats(fromFile, toFile);
    });
}

function getOnlyUniqueFilenames (list) {
  if (!isValidList(list))
    throw new TypeError(`Invalid list provided to getOnlyUniqueFilenames: ${list}`);
  return getOnlyUniqueValues(list, ({ name }) => name);
}

function getOnlyUniqueValues (list, transformValueFn) {
  if (!Array.isArray(list))
    throw new TypeError(`Invalid list provided to getOnlyUniqueValues: ${list}`);
  if (typeof transformValueFn !== 'function')
    transformValueFn = (value) => value;
  const duplicatedValues = [];
  const encounteredValues = []
  list.forEach(value => {
    const transformed = transformValueFn(value);
    if (encounteredValues.includes(transformed)) {
      if (!duplicatedValues.includes(transformed)) duplicatedValues.push(transformed);
    } else {
      encounteredValues.push(transformed);
    };
  });
  return list.filter(value => !duplicatedValues.includes(transformValueFn(value)));
}

function unique (list, transformValueFn) {
  if (!Array.isArray(list))
    throw new TypeError(`Invalid list provided to unique(): ${list}`);
  if (typeof transformValueFn !== 'function')
    transformValueFn = (value) => value;
  const output = [];
  const encounteredValues = []
  list.forEach(value => {
    const transformed = transformValueFn(value);
    if (!encounteredValues.includes(transformed)) {
      encounteredValues.push(transformed);
      output.push(value);
    };
  });
  return output;
}

function getCommonFiles (listMapperFn, ...lists) {
  if (!lists || !lists.length)
    throw new TypeError('No lists provided to getCommonFiles.');
  if (lists && lists.length && lists.some(list => !isValidList(list)))
    throw new TypeError(`Invalid lists provided to getCommonFiles: ${lists.toString()}`);
  if (typeof listMapperFn !== 'function')
    listMapperFn = (list) => list;

  const listSet = lists
    .map(filterDirectories)
    .map(listMapperFn);
  const [ initial, ...rest ] = listSet;
  return listSet.reduce((commonFiles, thisList) => {
    return getListIntersection(commonFiles, thisList);
  }, initial);
}

function isParentStructure (fileItem = {}) {
  const { type, content } = fileItem;
  return type === 'directory'
    && Array.isArray(content)
    && content.some(subItem => typeof subItem !== 'string');
}

function makeSorter (key) {
  return (a, b) => {
    if (a[key] > b[key]) return -1;
    if (b[key] > a[key]) return 1;
    return 0;
  };
}

function displayObject (object = {}) {
  return Object.keys(object)
    .reduce((output, key) => {
      const content = object[key];
      const color = (content === null ? 'dim' : content === true ? 'green' : content === false ? 'red' : 'blue')
      output += chalk.bold(key) + chalk.dim(': ');
      output += chalk[color](zaq.pretty(content));
      output += '\n';
      return output;
    }, '').trim();
};

function localize (pathname) {
  if (typeof pathname !== 'string') return pathname;
  return pathname.indexOf('.') === 0 ? pathname : './' + pathname;
};

module.exports = {
  diverge,
  fileExists,
  displayObject,
  dirExists,
  makeSorter,
  mapDirectory,
  unique,
  localize,
  flattenMap,
  getCommonFiles,
  generateObject,
  filterDirectories,
  getCommonFilesByHash,
  findFileByFilename,
  extractFileReferences,
  sortFileReferences,
  findFileByHash,
  findFileByUri,
  getCommonFilesByFilename,
  applyTextChanges,
  transformToHashList,
  transformToFilenameList,
  getOnlyUniqueValues,
  getResolvedShortName,
  getListUniques,
  isValidList,
  IMPORT_PATH_PATTERN
};
