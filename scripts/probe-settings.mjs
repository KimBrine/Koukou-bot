/** Live probes require an explicit target; never ship real account/group defaults. */
export function getProbeTarget(kind) {
  const option = process.argv.find(arg => arg.startsWith(`--${kind}=`))?.split('=')[1]
  const positional = /^\d{5,11}$/.test(process.argv[2] || '') ? process.argv[2] : ''
  const value = option || process.env[kind === 'group' ? 'PROBE_GROUP_ID' : 'PROBE_USER_ID'] || positional
  if (!/^\d{5,11}$/.test(value || '') || Number(value) <= 0) {
    throw new Error(`Specify --${kind}=<QQ ID> or ${kind === 'group' ? 'PROBE_GROUP_ID' : 'PROBE_USER_ID'} before running this live probe.`)
  }
  return Number(value)
}
