/* eslint-disable no-console */
const fs = require('fs')
const checker = require('license-checker-rseidelsohn')

checker.init(
  {
    start: process.cwd(),
    production: true,
    // Lizenztexte und Repo-URL mit ausgeben:
    customFormat: {
      name: '',
      version: '',
      licenses: '',
      licenseFile: '',
      licenseText: '',
      repository: '',
      publisher: ''
    }
  },
  (err, pkgs) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    const lines = ['# Third-Party Licenses\n']
    for (const [key, info] of Object.entries(pkgs)) {
      lines.push(
        `## ${key}`,
        `- **License:** ${info.licenses || 'n/a'}`,
        info.repository ? `- **Repo:** ${info.repository}` : '',
        info.publisher ? `- **Publisher:** ${info.publisher}` : '',
        info.licenseText ? `\n\`\`\`text\n${info.licenseText.trim()}\n\`\`\`\n` : '',
        '\n'
      )
    }
    fs.writeFileSync('THIRD_PARTY_NOTICES.md', lines.join('\n'), 'utf8')
    console.log('✅ THIRD_PARTY_NOTICES.md erzeugt.')
  }
)
