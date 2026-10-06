// Buddy's animated pet: a Client surface module with its own frame clock.
// Props come from the hooks module (species, mood, stage, name); clicks post back.

type Species = 'bunny' | 'cat' | 'dog' | 'bear' | 'frog' | 'owl' | 'ghost' | 'dragon'
type Mood = 'sleepy' | 'working' | 'happy' | 'holding' | 'tired'
type Props = { species?: Species; mood?: Mood; stage?: 'egg' | 'pet'; name?: string; label?: string }
type State = { frame: number; hearts: number; cracking: number }

// Two poses per species; {e} = eye, {m} = mouth. Three lines each, kept narrow.
const ART: Record<Species, [string[], string[]]> = {
  bunny: [
    [' (\\_/) ', ' ({e}{m}{e}) ', ' (")(") '],
    [' (\\ /) ', ' ({e}{m}{e}) ', 'o(")(") '],
  ],
  cat: [
    [' /\\_/\\ ', '( {e}{m}{e} )', ' > ^ < '],
    [' /\\_/\\ ', '( {e}{m}{e} )', ' (") (")~'],
  ],
  dog: [
    ['  __  ', '({e}{m}{e})_', ' U  U ~'],
    ['  __  ', '({e}{m}{e})_', ' U  U  ~'],
  ],
  bear: [
    [' ʕ•ᴥ•ʔ '.replace('•ᴥ•', '{e}{m}{e}'), ' /   \\ ', ' U   U '],
    [' ʕ•ᴥ•ʔ '.replace('•ᴥ•', '{e}{m}{e}'), ' \\   / ', ' U   U '],
  ],
  frog: [
    [' @..@ '.replace('..', '{e}{e}'), '({m}{m}{m}{m})', ' ^  ^ '],
    [' @..@ '.replace('..', '{e}{e}'), '({m}{m}{m}{m})', '^    ^'],
  ],
  owl: [
    [' {o,o} '.replace('o,o', '{e},{e}'), ' /)_) ', '  " "  '],
    [' {o,o} '.replace('o,o', '{e},{e}'), ' (_(\\ ', '  " "  '],
  ],
  ghost: [
    ['  .-.  ', ' ({e} {e}) ', ' | {m} | ', ' \'~~~\' '].slice(0, 3),
    ['  .-.  ', ' ({e} {e}) ', ' |{m}  | '],
  ],
  dragon: [
    ['  /\\_/\\_ ', ' ({e} {e} >', '  ^^ ~~ '],
    ['  /\\_/\\_ ', ' ({e} {e} >~', '  ^^  ~~'],
  ],
}

const FACE: Record<Mood, { e: string; m: string }> = {
  sleepy: { e: '-', m: '.' },
  working: { e: 'o', m: '_' },
  happy: { e: '^', m: 'w' },
  holding: { e: 'O', m: 'o' },
  tired: { e: 'x', m: '~' },
}

const EGG = [
  ['  .--.  ', ' /    \\ ', ' \\____/ '],
  ['  .--.  ', ' / .  \\ ', ' \\____/ '],
  ['  .--.  ', ' / /\\ \\ ', ' \\_\\/_/ '],
  [' * .  * ', ' \\/  \\/ ', ' \\____/ '],
]

const NOTES = ['♪', '♫', '♪ ♫', '♫ ♪']
const fill = (line: string, f: { e: string; m: string }) => line.split('{e}').join(f.e).split('{m}').join(f.m)
const pad = (n: number) => ' '.repeat(Math.max(0, n))

export default function Pet(props: Props, surface: any) {
  const { Box, Text } = surface.elements
  const s: State = surface.state ?? { frame: 0, hearts: 0, cracking: 0 }

  if (surface.state === undefined) {
    surface.setState({ frame: 0, hearts: 0, cracking: 0 })
    surface.every(220, () => {
      const cur: State = surface.state ?? { frame: 0, hearts: 0, cracking: 0 }
      surface.setState({
        frame: cur.frame + 1,
        hearts: Math.max(0, cur.hearts - 1),
        cracking: cur.cracking > 0 ? cur.cracking + 1 : 0,
      })
      if (cur.cracking >= 12) surface.post({ hatched: true })
    })
    surface.onPointer((ev: any) => {
      if (ev.type !== 'down') return
      const cur: State = surface.state ?? { frame: 0, hearts: 0, cracking: 0 }
      if ((props.stage ?? 'pet') === 'egg') {
        if (cur.cracking === 0) surface.setState({ ...cur, cracking: 1 })
      } else {
        surface.setState({ ...cur, hearts: 8 })
        surface.post({ petted: true })
      }
    })
  }

  const width = Math.max(14, surface.columns || 24)
  const f = s.frame

  if ((props.stage ?? 'pet') === 'egg') {
    const crack = s.cracking > 0 ? Math.min(3, Math.floor(s.cracking / 3)) : 0
    const wobble = s.cracking > 0 ? (f % 2 ? 1 : 0) : f % 6 === 0 ? 1 : 0
    const art = EGG[crack]
    return (
      <Box flexDirection="column">
        <Text color="yellow">{pad(4)}{s.cracking > 0 ? '  crack!' : ''}</Text>
        {art.map(line => (
          <Text color="yellow">{pad(4 + wobble)}{line}</Text>
        ))}
        <Text dimColor>{s.cracking > 0 ? 'hatching...' : 'Click the egg to hatch your Buddy'}</Text>
      </Box>
    )
  }

  const species: Species = props.species ?? 'bunny'
  const mood: Mood = props.mood ?? 'sleepy'
  const poses = ART[species] ?? ART.bunny
  const face = FACE[mood]
  const pose = poses[f % 2]
  const artWidth = Math.max(...pose.map(l => l.length))
  const room = Math.max(0, width - artWidth - 4)

  // Movement per mood.
  let x = 2
  let lift = 0
  let top = ' '
  let color = 'yellow'
  if (mood === 'working') {
    const span = Math.max(1, room)
    const step = f % (span * 2)
    x = 1 + (step < span ? step : span * 2 - step) // walk back and forth
  } else if (mood === 'happy') {
    lift = f % 2 // bounce
    x = 2 + (f % 4 < 2 ? 0 : 2) // sway
    top = pad(x + 1) + NOTES[f % NOTES.length]
    color = 'green'
  } else if (mood === 'holding') {
    x = 2 + (f % 2) // shake
    top = pad(x + 3) + '!'
    color = 'red'
  } else if (mood === 'tired') {
    top = pad(x + artWidth) + (f % 3 === 0 ? 'z' : f % 3 === 1 ? 'zZ' : 'zZz')
    color = 'gray'
  } else {
    top = pad(x + artWidth) + (f % 4 < 2 ? 'z' : ' z')
  }
  if (s.hearts > 0) top = pad(x + 1) + (s.hearts % 2 ? '♥ ♥' : ' ♥ ♥ ')

  const lines = pose.map(l => fill(l, face))
  return (
    <Box flexDirection="column">
      <Text color={s.hearts > 0 ? 'magenta' : 'yellow'}>{lift ? ' ' : top}</Text>
      {lift ? <Text color="yellow">{top}</Text> : null}
      {lines.map(l => (
        <Text color={color}>{pad(x)}{l}</Text>
      ))}
      {lift ? null : <Text> </Text>}
      <Text bold>{props.name ?? 'Buddy'}</Text>
      <Text dimColor>{props.label ?? ''}</Text>
    </Box>
  )
}
