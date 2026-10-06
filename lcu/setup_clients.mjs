// LCU names mapped to upstream installers; configuration formats belong upstream.
// Port of lcu/setup_clients.py. CLIENTS and ALIASES keep the Python insertion order.

/** @dataclass(frozen=True) class Client */
export class Client {
  constructor(label, executable, detect_path, mcp_agent) {
    this.label = label;
    this.executable = executable;
    this.detect_path = detect_path;
    this.mcp_agent = mcp_agent;
    Object.freeze(this);
  }
}

export const CLIENTS = Object.freeze({
  codex: new Client('Codex', 'codex', '.codex', 'codex'),
  'claude-code': new Client('Claude Code', 'claude', '.claude.json', 'claude-code'),
  pi: new Client('Pi', 'pi', '.pi/agent', 'pi'),
  omp: new Client('Oh My Pi', 'omp', '.omp', ''),
  hermes: new Client('Hermes', 'hermes', '.hermes', ''),
});

export const ALIASES = Object.freeze({ claude: 'claude-code', 'oh-my-pi': 'omp', 'hermes-agent': 'hermes' });
