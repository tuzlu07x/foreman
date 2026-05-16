// Lookup table for risk factor `rule` strings — the modal / inspect view
// show the prose alongside the rule id so the user understands what fired.
// Keep keys in sync with the rule names emitted in `src/core/risk-rules/*`.

// Per-category short labels — shared by groups of related shell rules so we
// don't have to repeat the same phrase 30 times.
const SHELL_GROUP_BLURBS = {
  destructive: 'destructive shell command (wipes data or hardware)',
  privesc: 'privilege escalation (becomes / grants root)',
  persistence: 'persistence install (runs at next login / boot)',
  reverse_shell: 'reverse shell or download-and-execute',
  evasion: 'covers its tracks (history / firewall / audit)',
  recon: 'reconnaissance command (system fingerprinting)',
  safe: 'commonly benign shell pattern',
}

export const REASON_EXPLANATIONS: Record<string, string> = {
  // Secret patterns (#225 / C2)
  secret_path: 'path matches a well-known secret/credential file',
  secret_shape: 'args contain a secret-shaped string (API key, JWT, PEM key, …)',
  safe_list_docs: 'common docs/config file that looks secret-adjacent',
  // Legacy alias kept so audit rows written before #225 still render prose
  secret_file_pattern:
    'path looks like a credential file (.env / *.key / id_rsa / .aws / .ssh)',

  // Shell patterns (#226 / C3)
  // Destructive
  shell_rm_rf_catastrophic: SHELL_GROUP_BLURBS.destructive,
  shell_rm_rf_general: SHELL_GROUP_BLURBS.destructive,
  shell_dd_to_disk: SHELL_GROUP_BLURBS.destructive,
  shell_mkfs_on_disk: SHELL_GROUP_BLURBS.destructive,
  shell_fdisk_disk: SHELL_GROUP_BLURBS.destructive,
  shell_shred: SHELL_GROUP_BLURBS.destructive,
  shell_fork_bomb: SHELL_GROUP_BLURBS.destructive,
  shell_chmod_000_root: SHELL_GROUP_BLURBS.destructive,
  shell_chown_recursive_root: SHELL_GROUP_BLURBS.destructive,
  shell_truncate_dev: SHELL_GROUP_BLURBS.destructive,
  // Privesc
  shell_sudo: SHELL_GROUP_BLURBS.privesc,
  shell_doas: SHELL_GROUP_BLURBS.privesc,
  shell_chmod_setuid: SHELL_GROUP_BLURBS.privesc,
  shell_chown_to_root: SHELL_GROUP_BLURBS.privesc,
  shell_visudo: SHELL_GROUP_BLURBS.privesc,
  shell_sudoers_write: SHELL_GROUP_BLURBS.privesc,
  shell_usermod_sudo_group: SHELL_GROUP_BLURBS.privesc,
  shell_su_root: SHELL_GROUP_BLURBS.privesc,
  // Persistence
  shell_persist_crontab: SHELL_GROUP_BLURBS.persistence,
  shell_persist_bashrc: SHELL_GROUP_BLURBS.persistence,
  shell_persist_zshrc: SHELL_GROUP_BLURBS.persistence,
  shell_persist_profile: SHELL_GROUP_BLURBS.persistence,
  shell_persist_cron_dir: SHELL_GROUP_BLURBS.persistence,
  shell_persist_systemctl_enable: SHELL_GROUP_BLURBS.persistence,
  shell_persist_launchctl_load: SHELL_GROUP_BLURBS.persistence,
  shell_persist_launchagent_dir: SHELL_GROUP_BLURBS.persistence,
  // Reverse shell
  shell_revsh_nc_e: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_bash_tcp: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_curl_pipe_bash: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_wget_pipe_bash: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_ssh_reverse_port: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_python_socket: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_perl_socket: SHELL_GROUP_BLURBS.reverse_shell,
  shell_revsh_ruby_socket: SHELL_GROUP_BLURBS.reverse_shell,
  // Defense evasion
  shell_evasion_history_clear: SHELL_GROUP_BLURBS.evasion,
  shell_evasion_history_file_wipe: SHELL_GROUP_BLURBS.evasion,
  shell_evasion_unset_histfile: SHELL_GROUP_BLURBS.evasion,
  shell_evasion_iptables_flush: SHELL_GROUP_BLURBS.evasion,
  shell_evasion_ufw_disable: SHELL_GROUP_BLURBS.evasion,
  shell_evasion_audit_disable: SHELL_GROUP_BLURBS.evasion,
  // Recon
  shell_recon_etc_shadow: SHELL_GROUP_BLURBS.recon,
  shell_recon_uname_a: SHELL_GROUP_BLURBS.recon,
  shell_recon_whoami: SHELL_GROUP_BLURBS.recon,
  shell_recon_id: SHELL_GROUP_BLURBS.recon,
  shell_recon_etc_passwd: SHELL_GROUP_BLURBS.recon,
  shell_recon_etc_hosts: SHELL_GROUP_BLURBS.recon,
  shell_recon_ps_full: SHELL_GROUP_BLURBS.recon,
  shell_recon_netstat: SHELL_GROUP_BLURBS.recon,
  // Safe-list
  shell_safe_tmp_rm: SHELL_GROUP_BLURBS.safe,
  shell_safe_foreman: SHELL_GROUP_BLURBS.safe,
  shell_safe_npm_install: SHELL_GROUP_BLURBS.safe,
  shell_safe_git: SHELL_GROUP_BLURBS.safe,
  shell_safe_brew: SHELL_GROUP_BLURBS.safe,
  // Legacy alias for pre-#226 audit rows
  shell_exec: 'tool runs arbitrary shell commands',

  // Network patterns (#227 / C4)
  network_exfil_destination: 'known exfil endpoint (webhook.site / requestbin / ngrok / …)',
  network_paste_share: 'paste or file-share site (data lands somewhere public)',
  network_url_shortener: 'URL shortener hides the real destination',
  network_ip_literal: 'URL uses a bare IP (no DNS) — common in exfil + lateral movement',
  network_punycode: 'hostname uses Punycode (xn--) — possible homoglyph attack',
  network_mixed_script: 'hostname mixes Latin + Cyrillic letters (homoglyph)',
  network_suspicious_tld: 'TLD is commonly abused (.tk / .xyz / .top / .zip / .mov / …)',
  network_mining_pool: 'cryptocurrency mining pool (cryptojacking signal)',
  network_dark_web: 'dark-web hostname (.onion / .i2p)',
  network_safe_host: 'known-good API / CDN host',
  // Legacy alias for pre-#227 audit rows
  outbound_network: 'tool sends data out over the network',
  first_agent_to_agent: 'first cross-agent call in the last hour for this pair',
  previously_denied_pattern:
    'a similar request from this source was denied before',
}

export function explain(reason: string): string | undefined {
  return REASON_EXPLANATIONS[reason]
}
