/*global env: true */
'use strict';

var doop = require('jsdoc/util/doop');
var fs = require('jsdoc/fs');
var helper = require('jsdoc/util/templateHelper');
var logger = require('jsdoc/util/logger');
var path = require('jsdoc/path');
var taffy = require('taffydb').taffy;
var template = require('jsdoc/template');
var util = require('util');
var _ = require('lodash');
var catharsis = require('catharsis');
//var parseMarkdown = require('jsdoc/util/markdown').getParser();
var tutorial = require('jsdoc/tutorial');

var htmlsafe = helper.htmlsafe;
var resolveAuthorLinks = helper.resolveAuthorLinks;
var scopeToPunc = helper.scopeToPunc;
var hasOwnProp = Object.prototype.hasOwnProperty;

var data;
var view;

var indexdir = path.normalize(env.opts.destination);
var outdir = path.join(indexdir, 'docs');

// These next two are lifted out of jsdoc3/util/templateHelper.js

function isComplexTypeExpression(expr) {
    // record types, type unions, and type applications all count as "complex"
    return /^{.+}$/.test(expr) || /^.+\|.+$/.test(expr) || /^.+<.+>$/.test(expr);
}
function parseType(longname) {
    var err;

    try {
        return catharsis.parse(longname, {jsdoc: true});
    }
    catch (e) {
        err = new Error('unable to parse ' + longname + ': ' + e.message);
        console.error(err);
        return longname;
    }
}

function headingId(heading) {
  return _.kebabCase(heading.toLowerCase().replace(/[^a-z ]/g, ''));
}

function getHeadings(html, level) {
  var result = [];
  var regexString = util.format('<h%s>(.*)<\/h%s>', level, level);
  var regex = new RegExp(regexString, 'gi');
  html.replace(regex, function (whole, heading) {
    result.push(heading);
    return whole;
  });
  return result;
}

function addHeadingIds(html) {
  return html.replace(/<h([0-9])>(.*?)<\/h[0-9]>/g, function(all, level, heading) {
    return util.format(
      '<h%s id="%s">%s</h%s>',
      level, headingId(heading), heading, level
    );
  });
}

function formatType(type) {
  switch (type.type) {
    case 'NameExpression':
      return linkto(type.name);
    case 'UndefinedLiteral':
      return 'undefined';
    case 'NullLiteral':
      return 'null';
    case 'TypeApplication':
      if (type.expression.name === 'Array') {
        return util.format(
          '%s[]',
          type.applications.map(formatType).join('')
        );
      }
      return util.format(
          '%s<%s>',
          formatType(type.expression),
          type.applications.map(formatType).join('')
      );
    case 'TypeUnion':
      return type.elements.map(formatType).join('|');
    default:
      throw new Error("Unknown type: `" + type.type + "`\nProblematic type:\n" + util.inspect(type, {depth: 10}));
  }
}

function generateTutorial(tutorial) {
  return helper.resolveLinks(tutorial.parse());
}

function createLink(doclet) {
  id = _.isString(doclet) ? doclet : elementId(doclet);
  return util.format("#%s", id);
}

function linkto() {

  var target = arguments[0];
  var display = arguments[1] || target;

  if (isComplexTypeExpression(target) && !_.startsWith(target, '{@')) {
    var parsed = parseType(target);
    return formatType(parsed);
  }

  var doclet = find({longname: target})[0] || find({name: target})[0];
  if (doclet) {
    return util.format(
      '<a href="%s">%s</a>',
      createLink(doclet),
      htmlsafe(display)
    );
  } else {
    return helper.linkto.apply(helper, arguments);
  }
}

function sectionId(doclet) {
  return util.format(
    "section-%s",
    elementId(doclet)
  );
}

function subsectionId(doclet, subsection) {
  return util.format(
    "%s-subsection-%s",
    elementId(doclet),
    subsection
  );
}

function sectionLink(section) {
  return createLink(sectionId(section));
}

function subsectionLink(doclet, subsection) {
  return createLink(subsectionId(doclet, subsection));
}

function constructorId(doclet) {
  return util.format(
    "%s-constructor",
    elementId(doclet)
  );
}

function elementId(doclet) {
  return (doclet.longname || doclet.name || '')
    .replace('#event:', '-event-')
    .replace('#', '-instance-')
    .replace('.', '-static-')
    .replace('"', '');
}

function find(spec) {
    return helper.find(data, spec);
}

function simplifyEventName(namepath) {
    var regex = /#(event:)?(.*)$/;
    var matches = namepath.match(regex);
    return matches[2] || namepath;
}

function formattedParent(data) {
  var parent = data.memberof;
  if (parent) {
    return data.isStatic || data.kind === 'class' ? parent : _.camelCase(parent);
  } else {
    return '';
  }
}

function tutoriallink(tutorial) {
    return helper.toTutorial(tutorial, null, { tag: 'em', classname: 'disabled', prefix: 'Tutorial: ' });
}

function getAncestorLinks(doclet) {
    return helper.getAncestorLinks(data, doclet);
}

function hashToLink(doclet, hash) {
    if ( !/^(#.+)/.test(hash) ) { return hash; }

    var url = createLink(doclet);

    url = url.replace(/(#.+|$)/, hash);
    return '<a href="' + url + '">' + hash + '</a>';
}

function isLodashMethod(doclet) {
  return !!_.find(doclet.see, function(name) {
    return _.contains(name, 'lodash.com');
  });
}

function needsFunctionSignature(doclet) {
    var needsSig = false;

    // function and class definitions always get a signature
    if (doclet.kind === 'function' || doclet.kind === 'class') {
        needsSig = true;
    }
    // typedefs that contain functions get a signature, too
    else if (doclet.kind === 'typedef' && doclet.type && doclet.type.names &&
        doclet.type.names.length) {
        for (var i = 0, l = doclet.type.names.length; i < l; i++) {
            if (doclet.type.names[i].toLowerCase() === 'function') {
                needsSig = true;
                break;
            }
        }
    }

    return needsSig;
}

function needsEventSignature(doclet) {
  return doclet.kind === 'event';
}

function getSignatureAttributes(item) {
    var attributes = [];

    if (item.nullable === true) {
        attributes.push('nullable');
    }
    else if (item.nullable === false) {
        attributes.push('non-null');
    }

    return attributes;
}

function updateItemName(item, options) {
    options = _.extend({default: false}, options);
    var attributes = getSignatureAttributes(item);
    var itemName = item.name || '';

    // Wrap item name in span.
    itemName = util.format('<span class="item-name">%s</span>', itemName);

    // Prefix varargs parameter with ellipsis.
    if (item.variable) {
        itemName = '<span class="variable-ellipsis">&hellip;</span>' + itemName;
    }

    if (options.default && !_.isUndefined(item.defaultvalue)) {
      itemName +=
        '<span class="default-value">' +
          '<span class="default-equals">=</span>' +
          '<span class="default-value">' +
            item.defaultvalue +
          '</span>' +
        '</span>';
    }

    // Embracket optional param.
    if (item.optional) {
      itemName =
        '<span class="optional-bracket">[</span>' +
          itemName +
        '<span class="optional-bracket">]</span>';
    }

    if (attributes && attributes.length) {
        itemName = util.format( '%s<span class="signature-attributes">%s</span>', itemName,
            attributes.join(' ') );
    }

    return itemName;
}

function addParamAttributes(params) {
    return params.filter(function(param) {
        return param.name && param.name.indexOf('.') === -1;
    }).map(updateItemName);
}

function buildItemTypeStrings(item) {
    var types = [];

    if (item && item.type && item.type.names) {
        item.type.names.forEach(function(name) {
            types.push( linkto(name, htmlsafe(name)) );
        });
    }

    return types;
}

function buildAttribsString(attribs) {
    var attribsString = '';

    if (attribs && attribs.length) {
        attribsString = htmlsafe( util.format('(%s) ', attribs.join(', ')) );
    }

    return attribsString;
}

function addNonParamAttributes(items) {
    var types = [];

    items.forEach(function(item) {
        types = types.concat( buildItemTypeStrings(item) );
    });

    return types;
}

function ensureQuotes(string) {
  return string[0] === '"' ? string : util.format('"%s"', string);
}

function stripQuotes(string) {
  return string.replace(/^"|"$/g, '');
}

function paren(isOpening) {
  return (
    '<span class="parenthesis">' +
      (isOpening ? '(' : ')') +
    '</span>'
  );
}

function comma() {
  return '<span class="comma">, </span>'
}

function parens(string) {
  return paren(true) + string + paren(false);
}

function parameterList(params) {
  params = params ? addParamAttributes(params) : [];
  return parens(params.join(comma()));
}

function addEventSignature(doclet) {
  var p = parameterList(doclet.params);
  doclet.signature = util.format(
    '<span class="event-on">on</span>%s%s%s %s <span class="fat-arrow">=&gt;</span>',
    paren(true),
    linkto(doclet.longname, ensureQuotes(doclet.name)),
    comma(),
    parameterList(doclet.params)
  );
}

function addSignatureName(doclet) {
  var target = doclet.isLodashMethod ? doclet.see[0] : doclet.longname ;
  doclet.signature = util.format(
    '<span class="name">%s</span>%s',
    linkto(target, doclet.name),
    doclet.signature || ''
  );
}

function addSignatureParams(f) {
  var params = f.params ? addParamAttributes(f.params) : [];
  f.signature = util.format('%s%s', f.signature, parameterList(f.params));
}

function addSignatureReturns(f) {
    var attribs = [];
    var attribsString = '';
    var returnTypes = [];
    var returnTypesString = '';

    // jam all the return-type attributes into an array. this could create odd
    // results (for example, if there are both nullable and non-nullable return
    // types), but let's assume that most people who use multiple @return tags
    // aren't using Closure Compiler type annotations, and vice-versa.
    if (f.returns) {
        f.returns.forEach(function(item) {
            helper.getAttribs(item).forEach(function(attrib) {
                if (attribs.indexOf(attrib) === -1) {
                    attribs.push(attrib);
                }
            });
        });

        attribsString = buildAttribsString(attribs);
    }

    if (f.returns) {
        returnTypes = addNonParamAttributes(f.returns);
    }
    if (returnTypes.length) {
        returnTypesString = util.format(
            ' &rarr; %s %s',
            attribsString ? util.format('(%s)', attribsString) : '',
            returnTypes.join('|')
        );
    }

    f.signature = '<span class="parameters">' + (f.signature || '') + '</span>' +
        '<span class="type-signature">' + returnTypesString + '</span>';
}

function addSignatureTypes(f) {
    var types = f.type ? buildItemTypeStrings(f) : [];

    f.signature = (f.signature || '') + '<span class="type-signature">' +
        (types.length ? ' :' + types.join('|') : '') + '</span>';
}

function addAttribs(f) {
    var attribs = helper.getAttribs(f);

    // Manually assign `isStatic`.
    f.isStatic = _.contains(attribs, 'static');
    if (f.isStatic) _.pull(attribs, 'static')

    // Remove `static` from list. TODO: Do this for all 'attributes'.
    var attribsString = buildAttribsString(attribs);


    f.attribs = util.format('<span class="type-signature">%s</span>', attribsString);
}

function shortenPaths(files, commonPrefix) {
    Object.keys(files).forEach(function(file) {
        files[file].shortened = files[file].resolved.replace(commonPrefix, '')
            // always use forward slashes
            .replace(/\\/g, '/');
    });

    return files;
}

function getPathFromDoclet(doclet) {
    if (!doclet.meta) {
        return null;
    }

    return doclet.meta.path && doclet.meta.path !== 'null' ?
        path.join(doclet.meta.path, doclet.meta.filename) :
        doclet.meta.filename;
}

function generate(type, title, docs, filename, resolveLinks, className) {
    resolveLinks = resolveLinks === false ? false : true;

    var docData = {
        type: type,
        title: title,
        docs: docs,
        className: className,
        subdir: type == 'index' ? 'docs/' : '',
        rootdir: type == 'index' ? '' : '../'
    };

    var outpath = filename,
        html = view.render('container.tmpl', docData);

    if (resolveLinks) {
        html = helper.resolveLinks(html); // turn {@link foo} into <a href="foodoc.html">foo</a>
    }

    fs.writeFileSync(outpath, html, 'utf8');
}

function generateSourceFiles(sourceFiles, encoding) {
    encoding = encoding || 'utf8';
    Object.keys(sourceFiles).forEach(function(file) {
        var source;
        // links are keyed to the shortened path in each doclet's `meta.shortpath` property
        var sourceOutfile = path.join(
          'docs',
          helper.getUniqueFilename(sourceFiles[file].shortened)
        );
        helper.registerLink(sourceFiles[file].shortened, sourceOutfile);

        try {
            source = {
                kind: 'source',
                code: helper.htmlsafe( fs.readFileSync(sourceFiles[file].resolved, encoding) )
            };
        }
        catch(e) {
            logger.error('Error while generating source file %s: %s', file, e.message);
        }

        generate('Source', sourceFiles[file].shortened, [source], sourceOutfile, false, 'source-page');
    });
}

/**
 * Look for classes or functions with the same name as modules (which indicates that the module
 * exports only that class or function), then attach the classes or functions to the `module`
 * property of the appropriate module doclets. The name of each class or function is also updated
 * for display purposes. This function mutates the original arrays.
 *
 * @private
 * @param {Array.<module:jsdoc/doclet.Doclet>} doclets - The array of classes and functions to
 * check.
 * @param {Array.<module:jsdoc/doclet.Doclet>} modules - The array of module doclets to search.
 */
function attachModuleSymbols(doclets, modules) {
    var symbols = {};

    // build a lookup table
    doclets.forEach(function(symbol) {
        symbols[symbol.longname] = symbols[symbol.longname] || [];
        symbols[symbol.longname].push(symbol);
    });

    return modules.map(function(module) {
        if (symbols[module.longname]) {
            module.modules = symbols[module.longname]
                // Only show symbols that have a description. Make an exception for classes, because
                // we want to show the constructor-signature heading no matter what.
                .filter(function(symbol) {
                    return symbol.description || symbol.kind === 'class';
                })
                .map(function(symbol) {
                    symbol = doop(symbol);

                    if (symbol.kind === 'class' || symbol.kind === 'function') {
                        symbol.name = symbol.name.replace('module:', '(require("') + '"))';
                    }

                    return symbol;
                });
        }
    });
}

function buildSubsectionLink(doclet, subsection, title) {
  return util.format(
    '<h4><a href="%s">%s</a></h4>',
    subsectionLink(doclet, subsection),
    title
  );
}

function buildNavItemList(items, className, linktoFn) {
  var listItems = items.map(function (item) {
    return '<li>' + linktoFn(item.longname, stripQuotes(item.title || item.name)) + '</li>';
  });

  return util.format('<ul class="%s">%s</ul>', className || '', listItems.join(''));
}

function buildTutorialsNav(tutorials) {
  return tutorials.map(function(tutorial) {
    var result = util.format(
      '<li><h3>%s</h3>',
      linkto(tutorial.longname, tutorial.title)
    );
    if (tutorial.children) {
      result += buildNavItemList(tutorial.children, 'sections', linkto);
    }
    return result + '</li>';
  });
}

function buildReadmeNav(readme) {
  var headings = getHeadings(readme, 2);
  var items = headings.map(function(heading) {
    return util.format(
      '<li><h3><a href="%s">%s</a></h3></li>',
      createLink(headingId(heading)),
      heading
    );
  }).join('\n');
  return util.format('<ul class="readme">%s</ul>', items);
}

function buildChangelogNav() {
  return (
    '<ul class="changelog">' +
      '<li><h3><a href="#changelog">Change log</a></h3></li>' +
    '</ul>'
  );
}

function buildMemberNav(item) {
  var itemsNav = '';
  var statics = find({kind:'function', isStatic: true, memberof: item.longname});
  var members = find({kind:'member', memberof: item.longname});
  var methods = find({kind:'function', isInitialize: false, isLodashMethod: false, isStatic: false, memberof: item.longname});
  var lodash = find({kind:'function', isLodashMethod: true, memberof: item.longname});
  var events = find({kind:'event', memberof: item.longname});
  var classes = find({kind:'class', memberof: item.longname});
  var initialize = find({kind:'function', isInitialize: true, isLodashMethod: false, isStatic: false, memberof: item.longname});

  if ( !hasOwnProp.call(item, 'longname') ) {
      itemsNav += '<li>' + linkto('', item.name);
      itemsNav += '</li>';
  } else {
      var itemName = 
      itemsNav += '<li>';
      itemsNav += util.format(
        '<h3><a href="%s">%s</a></h3>',
        sectionLink(item),
        item.name.replace(/^module:/, '')
      );

      /*
      itemsNav +=
        '<ul class="constructor"><li>' +
          linkto(item.longname, 'constructor') +
        '</li></ul>';
        */
      itemsNav += buildSubsectionLink(item, 'construction', 'Construction');
      itemsNav += buildNavItemList([item].concat(initialize), 'construction', linkto);

      if (statics.length) {
          itemsNav += buildSubsectionLink(item, 'static', 'Static');
          itemsNav += buildNavItemList(statics, 'static', linkto);
      }
      if (members.length) {
          itemsNav += buildSubsectionLink(item, 'members', 'Members');
          itemsNav += buildNavItemList(members, 'members', linkto);
      }
      if (methods.length) {
          itemsNav += buildSubsectionLink(item, 'methods', 'Methods');
          itemsNav += buildNavItemList(methods, 'methods', linkto);
      }
      if (lodash.length) {
          itemsNav += buildSubsectionLink(item, 'lodash-methods', 'Lodash Methods');
          itemsNav += buildNavItemList(lodash, 'lodash-methods', linkto);
      }
      if (events.length) {
          itemsNav += buildSubsectionLink(item, 'events', 'Events');
          itemsNav += buildNavItemList(events, 'events', linkto);
      }
      itemsNav += '</li>';
  }

  itemsNav += classes.map(buildMemberNav).join('');
  return itemsNav;
}

function buildMemberNavs(items, itemHeading, itemsSeen, linktoFn) {
    return items.length
      ? items.map(buildMemberNav).join('')
      : '';
}

function linktoTutorial(longName, name) {
    return tutoriallink(name);
}

function linktoExternal(longName, name) {
    return linkto(longName, name.replace(/(^"|"$)/g, ''));
}

/**
 * Create the navigation sidebar.
 * @param {object} members The members that will be used to create the sidebar.
 * @param {array<object>} members.classes
 * @param {array<object>} members.externals
 * @param {array<object>} members.globals
 * @param {array<object>} members.mixins
 * @param {array<object>} members.modules
 * @param {array<object>} members.namespaces
 * @param {array<object>} members.tutorials
 * @param {array<object>} members.events
 * @param {array<object>} members.interfaces
 * @return {string} The HTML for the navigation sidebar.
 */
var bs = 0;
function buildNav(members, readme) {
    var nav = '';
    var seen = {};
    var seenTutorials = {};

    nav += buildReadmeNav(readme);

    nav += buildChangelogNav()

    nav += '<ul class="main">';
    nav += buildTutorialsNav(members.tutorials);
    nav += buildMemberNavs(members.topLevelClasses, 'Classes', seen, linkto);
    //nav += buildMemberNav(members.modules, 'Modules', {}, linkto);
    //nav += buildMemberNav(members.externals, 'Externals', seen, linktoExternal);
    //nav += buildMemberNav(members.events, 'Events', seen, linkto);
    //nav += buildMemberNav(members.namespaces, 'Namespaces', seen, linkto);
    //nav += buildMemberNav(members.mixins, 'Mixins', seen, linkto);
    //nav += buildMemberNav(members.tutorials, 'Tutorials', seenTutorials, linktoTutorial);
    //nav += buildMemberNav(members.interfaces, 'Interfaces', seen, linkto);
    nav += '</ul>';

    if (members.globals.length) {
        var globalNav = '';

        members.globals.forEach(function(g) {
            if ( g.kind !== 'typedef' && !hasOwnProp.call(seen, g.longname) ) {
                globalNav += '<li>' + linkto(g.longname, g.name) + '</li>';
            }
            seen[g.longname] = true;
        });

        if (!globalNav) {
            // turn the heading into a link so you can actually get to the global page
            nav += '<h3>' + linkto('global', 'Global') + '</h3>';
        }
        else {
            nav += '<h3>Global</h3><ul>' + globalNav + '</ul>';
        }
    }

    return nav;
}

/**
    @param {TAFFY} taffyData See <http://taffydb.com/>.
    @param {object} opts
    @param {Tutorial} tutorials
 */
exports.publish = function(taffyData, opts, tutorials) {
    data = taffyData;

    var conf = env.conf.templates || {};
    conf.default = conf.default || {};

    var templatePath = path.normalize(opts.template);
    view = new template.Template( path.join(templatePath, 'tmpl') );

    // claim some special filenames in advance, so the All-Powerful Overseer of Filename Uniqueness
    // doesn't try to hand them out later
    var indexUrl = helper.getUniqueFilename('index');
    // don't call registerLink() on this one! 'index' is also a valid longname

    var globalUrl = helper.getUniqueFilename('global');
    helper.registerLink('global', globalUrl);

    // set up templating
    view.layout = conf.default.layoutFile ?
        path.getResourcePath(path.dirname(conf.default.layoutFile),
            path.basename(conf.default.layoutFile) ) :
        'layout.tmpl';

    // set up tutorials for helper
    helper.setTutorials(tutorials);

    function registerTutorial(tutorial) {
      var url = createLink(tutorial);
      helper.registerLink(tutorial.longname, url);
      tutorial.children.forEach(registerTutorial);
    };

    tutorials.children.forEach(registerTutorial);

    data = helper.prune(data);
    data.sort('longname, version, since');
    helper.addEventListeners(data);

    var sourceFiles = {};
    var sourceFilePaths = [];
    data().each(function(doclet) {
      doclet.attribs = '';

      // Identify Lodash methods to be stubbed.
      doclet.isLodashMethod = isLodashMethod(doclet);
      doclet.isInitialize = doclet.name == 'initialize';

      if (doclet.examples) {
        doclet.examples = doclet.examples.map(function(example) {
          var caption, code;

          if (example.match(/^\s*<caption>([\s\S]+?)<\/caption>(\s*[\n\r])([\s\S]+)$/i)) {
            caption = RegExp.$1;
            code = RegExp.$3;
          }

          return {
            caption: caption || '',
            code: code || example
          };
        });
      }
      if (doclet.see) {
        doclet.see.forEach(function(seeItem, i) {
          doclet.see[i] = hashToLink(doclet, seeItem);
        });
      }

      // build a list of source files
      var sourcePath;
      if (doclet.meta) {
        sourcePath = getPathFromDoclet(doclet);
        sourceFiles[sourcePath] = {
          resolved: sourcePath,
          shortened: null
        };
        if (sourceFilePaths.indexOf(sourcePath) === -1) {
          sourceFilePaths.push(sourcePath);
        }
      }
    });

    // update outdir if necessary, then create outdir
    var packageInfo = ( find({kind: 'package'}) || [] ) [0];
    if (packageInfo && packageInfo.name) {
        outdir = path.join( outdir, packageInfo.name, (packageInfo.version || '') );
    }
    fs.mkPath(outdir);

    // copy the template's static files to outdir
    var fromDir = path.join(templatePath, 'static');
    var staticFiles = fs.ls(fromDir, 3);

    // Add fontawesome...

    staticFiles.forEach(function(fileName) {
        var toDir = fs.toDir( fileName.replace(fromDir, outdir) );
        fs.mkPath(toDir);
        fs.copyFileSync(fileName, toDir);
    });

    // copy user-specified static files to outdir
    var staticFilePaths;
    var staticFileFilter;
    var staticFileScanner;
    if (conf.default.staticFiles) {
        // The canonical property name is `include`. We accept `paths` for backwards compatibility
        // with a bug in JSDoc 3.2.x.
        staticFilePaths = conf.default.staticFiles.include ||
            conf.default.staticFiles.paths ||
            [];
        staticFileFilter = new (require('jsdoc/src/filter')).Filter(conf.default.staticFiles);
        staticFileScanner = new (require('jsdoc/src/scanner')).Scanner();

        staticFilePaths.forEach(function(filePath) {
            var extraStaticFiles = staticFileScanner.scan([filePath], 10, staticFileFilter);

            extraStaticFiles.forEach(function(fileName) {
                var sourcePath = fs.toDir(filePath);
                var toDir = fs.toDir( fileName.replace(sourcePath, outdir) );
                fs.mkPath(toDir);
                fs.copyFileSync(fileName, toDir);
            });
        });
    }

    if (sourceFilePaths.length) {
        sourceFiles = shortenPaths( sourceFiles, path.commonPrefix(sourceFilePaths) );
    }
    data().each(function(doclet) {
        var url = createLink(doclet);
        helper.registerLink(doclet.longname, url);

        // add a shortened version of the full path
        var docletPath;
        if (doclet.meta) {
            docletPath = getPathFromDoclet(doclet);
            docletPath = sourceFiles[docletPath].shortened;
            if (docletPath) {
                doclet.meta.shortpath = docletPath;
            }
        }
    });

    data().each(function(doclet) {
        var url = helper.longnameToUrl[doclet.longname];

        doclet.id = elementId(doclet);

        if ( needsFunctionSignature(doclet) ) {
            addSignatureName(doclet);
            addSignatureParams(doclet);
            addSignatureReturns(doclet);
            addAttribs(doclet);
        } else if (needsEventSignature(doclet)) {
            addEventSignature(doclet);
        }
    });

    // do this after the urls have all been generated
    data().each(function(doclet) {
        doclet.ancestors = getAncestorLinks(doclet);

        if (doclet.kind === 'member') {
            addSignatureName(doclet);
            addSignatureTypes(doclet);
            addAttribs(doclet);
        }

        if (doclet.kind === 'constant') {
            addSignatureTypes(doclet);
            addAttribs(doclet);
            doclet.kind = 'member';
        }
    });

    var members = helper.getMembers(data);
    members.tutorials = tutorials.children;

    // set up the lists that we'll use to generate pages
    var classes = taffy(members.classes);
    var modules = taffy(members.modules);
    var namespaces = taffy(members.namespaces);
    var mixins = taffy(members.mixins);
    var externals = taffy(members.externals);
    var interfaces = taffy(members.interfaces);

    // Find and store top level classes.
    var topLevelClasses = helper.find(classes, {memberof: {isUndefined: true}});

    var whitelist = opts.whitelist;
    if (whitelist) {
      topLevelClasses = whitelist.map(function(longname) {
        var result = _.find(topLevelClasses, {longname: longname});
        if (!result) throw new Error('White listed class `' + longname + '` not found');
        return result;
      });
    }

    members.topLevelClasses = topLevelClasses;


    // output pretty-printed source files by default
    var outputSourceFiles = conf.default && conf.default.outputSourceFiles !== false 
        ? true 
        : false;

    var showInheritedFrom = conf.default && conf.default.showInheritedFrom !== false
      ? true
      : false

    // add template helpers
    view.find = find;
    view.linkto = linkto;
    view.updateItemName = updateItemName;
    view.elementId = elementId;
    view.sectionId = sectionId;
    view.subsectionId = subsectionId;
    view.simplifyEventName = simplifyEventName;
    view.formattedParent = formattedParent;
    view.resolveAuthorLinks = resolveAuthorLinks;
    view.htmlsafe = htmlsafe;
    view.outputSourceFiles = outputSourceFiles;
    view.showInheritedFrom = showInheritedFrom;
    view.generateTutorial = generateTutorial;
    view.moment = require('moment');

    // once for all
    view.nav = buildNav(members, opts.readme);
    attachModuleSymbols( find({ longname: {left: 'module:'} }), members.modules );

    // generate the pretty-printed source files first so other pages can link to them
    if (outputSourceFiles) {
        generateSourceFiles(sourceFiles, opts.encoding);
    }

    if (members.globals.length) { 
        generate('', 'Global', [{kind: 'globalobj'}], globalUrl); 
    }

    // index page displays information from package.json and lists files
    var files = find({kind: 'file'});
    var packages = find({kind: 'package'});

    // Get changelog.
    var changelog = fs.readFileSync(opts.changelog, opts.encoding);
    changelog = new tutorial.Tutorial(null, changelog, tutorial.TYPES.MARKDOWN);

    generate('index', 'Bookshelf.js',
      packages.concat(
          [{kind: 'mainpage',
            readme: addHeadingIds(opts.readme),
            tutorials: tutorials,
            longname: (opts.mainpagetitle) ? opts.mainpagetitle : 'Main Page'
          }]
      ).concat(topLevelClasses).concat(files).concat({
        kind: 'mainpage', changelog: changelog
      }),
      indexUrl
    );

    /*
    Object.keys(helper.longnameToUrl).forEach(function(longname) {
        var myModules = helper.find(modules, {longname: longname});
        if (myModules.length) {
            generate('Module', myModules[0].name, myModules, helper.longnameToUrl[longname]);
        }

        var myClasses = helper.find(classes, {longname: longname});
        if (myClasses.length) {
            generate('Class', myClasses[0].name, myClasses, helper.longnameToUrl[longname]);
        }

        var myNamespaces = helper.find(namespaces, {longname: longname});
        if (myNamespaces.length) {
            generate('Namespace', myNamespaces[0].name, myNamespaces, helper.longnameToUrl[longname]);
        }

        var myMixins = helper.find(mixins, {longname: longname});
        if (myMixins.length) {
            generate('Mixin', myMixins[0].name, myMixins, helper.longnameToUrl[longname]);
        }

        var myExternals = helper.find(externals, {longname: longname});
        if (myExternals.length) {
            generate('External', myExternals[0].name, myExternals, helper.longnameToUrl[longname]);
        }

        var myInterfaces = helper.find(interfaces, {longname: longname});
        if (myInterfaces.length) {
            generate('Interface', myInterfaces[0].name, myInterfaces, helper.longnameToUrl[longname]);
        }
    });
    */
};
