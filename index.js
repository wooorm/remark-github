'use strict'

var visit = require('unist-util-visit')
var toString = require('mdast-util-to-string')
var findAndReplace = require('mdast-util-find-and-replace')

module.exports = github

// Hide process use from browserify and the like.
var proc = typeof global !== 'undefined' && global.process

// Load `fs` and `path` if available.
var fs
var path

try {
  fs = require('fs')
  path = require('path')
} catch (_) {}

// Previously, GitHub linked `@mention` and `@mentions` to their blog post about
// mentions (<https://github.com/blog/821>).
// Since June 2019, and possibly earlier, they stopped linking those references.
var denyMention = ['mention', 'mentions']

// Denylist of SHAs that are also valid words.
//
// GitHub allows abbreviating SHAs up to 7 characters.
// These cases are ignored in text because they might just be ment as normal
// words.
// If you’d like these to link to their SHAs, use more than 7 characters.
//
// Generated by:
//
// ```sh
// egrep -i "^[a-f0-9]{7,}$" /usr/share/dict/words
// ```
//
// Added a couple forms of 6 character words in GH-20:
// <https://github.com/remarkjs/remark-github/issues/20>.
var denyHash = ['acceded', 'deedeed', 'defaced', 'effaced', 'fabaceae']

// Constants.
var minShaLength = 7

// Username may only contain alphanumeric characters or single hyphens, and
// cannot begin or end with a hyphen*.
//
// \* That is: until <https://github.com/remarkjs/remark-github/issues/13>.
var userGroup = '[\\da-z][-\\da-z]{0,38}'
var projectGroup = '(?:\\.git[\\w-]|\\.(?!git)|[\\w-])+'
var repoGroup = '(' + userGroup + ')\\/(' + projectGroup + ')'

var linkRegex = new RegExp(
  '^https?:\\/\\/github\\.com\\/' +
    repoGroup +
    '\\/(commit|issues|pull)\\/([a-f\\d]+\\/?(?=[#?]|$))',
  'i'
)

var repoRegex = new RegExp(
  '(?:^|/(?:repos/)?)' + repoGroup + '(?=\\.git|[\\/#@]|$)',
  'i'
)

var referenceRegex = new RegExp(
  '(' +
    userGroup +
    ')(?:\\/(' +
    projectGroup +
    '))?(?:#([1-9]\\d*)|@([a-f\\d]{7,40}))',
  'gi'
)

var mentionRegex = new RegExp(
  '@(' + userGroup + '(?:\\/' + userGroup + ')?)',
  'gi'
)

function github(options) {
  var settings = options || {}
  var repository = settings.repository
  var pkg

  // Get the repository from `package.json`.
  if (!repository) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(proc.cwd(), 'package.json')))
    } catch (_) {}

    repository =
      pkg && pkg.repository ? pkg.repository.url || pkg.repository : ''
  }

  // Parse the URL: See the tests for all possible kinds.
  repository = repoRegex.exec(repository)

  if (!repository) {
    throw new Error('Missing `repository` field in `options`')
  }

  repository = {user: repository[1], project: repository[2]}

  return transformer

  function transformer(tree) {
    findAndReplace(
      tree,
      [
        [referenceRegex, replaceReference],
        [mentionRegex, replaceMention],
        [/(?:#|\bgh-)([1-9]\d*)/gi, replaceIssue],
        [/\b[a-f\d]{7,40}\b/gi, replaceHash]
      ],
      {ignore: ['link', 'linkReference']}
    )
    visit(tree, 'link', visitor)
  }

  function replaceMention(value, username, match) {
    var node

    if (
      /[\w`]/.test(match.input.charAt(match.index - 1)) ||
      /[/\w`]/.test(match.input.charAt(match.index + value.length)) ||
      denyMention.indexOf(username) !== -1
    ) {
      return false
    }

    node = {type: 'text', value: value}

    if (settings.mentionStrong !== false) {
      node = {type: 'strong', children: [node]}
    }

    return {
      type: 'link',
      title: null,
      url: 'https://github.com/' + username,
      children: [node]
    }
  }

  function replaceIssue(value, no, match) {
    if (
      /\w/.test(match.input.charAt(match.index - 1)) ||
      /\w/.test(match.input.charAt(match.index + value.length))
    ) {
      return false
    }

    return {
      type: 'link',
      title: null,
      url:
        'https://github.com/' +
        repository.user +
        '/' +
        repository.project +
        '/issues/' +
        no,
      children: [{type: 'text', value: value}]
    }
  }

  function replaceHash(value, match) {
    if (
      /[^\t\n\r (@[{]/.test(match.input.charAt(match.index - 1)) ||
      /\w/.test(match.input.charAt(match.index + value.length)) ||
      denyHash.indexOf(value) !== -1
    ) {
      return false
    }

    return {
      type: 'link',
      title: null,
      url:
        'https://github.com/' +
        repository.user +
        '/' +
        repository.project +
        '/commit/' +
        value,
      children: [{type: 'inlineCode', value: abbr(value)}]
    }
  }

  function replaceReference($0, user, project, no, sha, match) {
    var value = ''
    var nodes

    if (
      /[^\t\n\r (@[{]/.test(match.input.charAt(match.index - 1)) ||
      /\w/.test(match.input.charAt(match.index + $0.length))
    ) {
      return false
    }

    nodes = []

    if (user !== repository.user) {
      value += user
    }

    if (project && project !== repository.project) {
      value = user + '/' + project
    }

    if (no) {
      value += '#' + no
    } else {
      value += '@'
      nodes.push({type: 'inlineCode', value: abbr(sha)})
    }

    nodes.unshift({type: 'text', value: value})

    return {
      type: 'link',
      title: null,
      url:
        'https://github.com/' +
        user +
        '/' +
        (project || repository.project) +
        '/' +
        (no ? 'issues' : 'commit') +
        '/' +
        (no || sha),
      children: nodes
    }
  }

  function visitor(node) {
    var link = parse(node)
    var children
    var base
    var comment

    if (!link) {
      return
    }

    comment = link.comment ? ' (comment)' : ''

    if (link.project !== repository.project) {
      base = link.user + '/' + link.project
    } else if (link.user === repository.user) {
      base = ''
    } else {
      base = link.user
    }

    if (link.page === 'commit') {
      children = []

      if (base) {
        children.push({type: 'text', value: base + '@'})
      }

      children.push({type: 'inlineCode', value: abbr(link.reference)})

      if (link.comment) {
        children.push({type: 'text', value: comment})
      }
    } else {
      base += '#'
      children = [{type: 'text', value: base + abbr(link.reference) + comment}]
    }

    node.children = children
  }
}

// Abbreviate a SHA.
function abbr(sha) {
  return sha.slice(0, minShaLength)
}

// Parse a link and determine whether it links to GitHub.
function parse(node) {
  var url = node.url || ''
  var match = linkRegex.exec(url)

  if (
    // Not a proper URL.
    !match ||
    // Looks like formatting.
    node.children.length !== 1 ||
    node.children[0].type !== 'text' ||
    toString(node) !== url ||
    // Issues / PRs are decimal only.
    (match[3] !== 'commit' && /[a-f]/i.test(match[4])) ||
    // SHAs can be min 4, max 40 characters.
    (match[3] === 'commit' && (match[4].length < 4 || match[4].length > 40)) ||
    // Projects can be at most 99 characters.
    match[2].length >= 100
  ) {
    return
  }

  return {
    user: match[1],
    project: match[2],
    page: match[3],
    reference: match[4],
    comment:
      url.charAt(match[0].length) === '#' && match[0].length + 1 < url.length
  }
}
