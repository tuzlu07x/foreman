class ForemanAgent < Formula
  desc "Local security gateway for AI coding agents: mediates, scores, asks, audits"
  homepage "https://foreman-agent.com"
  url "https://registry.npmjs.org/foreman-agent/-/foreman-agent-2.4.0.tgz"
  sha256 "d960902506929c8945820f83ff4c086614dd130a5c7d6b04cdfdd52e6dfd89b0"
  license "MIT"
  head "https://github.com/tuzlu07x/foreman.git", branch: "main"

  depends_on "node"

  def install
    # The native SQLite module (better-sqlite3) ships prebuilt N-API
    # binaries, so no install scripts need to run.
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")

    generate_completions_from_executable(bin/"foreman", "completion")
  end

  def caveats
    <<~EOS
      Get started:
        foreman setup      # 5-minute wizard: providers, agents, services
        foreman start      # the TUI, where risky calls wait for your OK

      Optional: `foreman service install` keeps Foreman running at
      login. It runs Homebrew's Node by its full path, so run it again after
      `brew upgrade` updates node or foreman-agent (`foreman service status`
      warns when it points at a version that is gone).

      Foreman keeps its state (identity key, policy.yaml, audit database)
      outside the Homebrew prefix; `foreman doctor` prints where. Upgrading
      or uninstalling the formula does NOT touch it. For a clean removal see
        https://github.com/tuzlu07x/foreman/blob/main/docs/install.md#uninstall
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/foreman --version")
    system bin/"foreman", "--help"
    assert_match "complete -F", shell_output("#{bin}/foreman completion bash")
    assert_match "#compdef foreman", shell_output("#{bin}/foreman completion zsh")
    assert_match "foreman_no_subcommand", shell_output("#{bin}/foreman completion fish")

    # A throwaway home: init must work and doctor must find the database.
    ENV["FOREMAN_HOME"] = testpath/"foreman"
    ENV["FOREMAN_NO_UPDATE_CHECK"] = "1"
    system bin/"foreman", "init"
    assert_match "migrations", shell_output("#{bin}/foreman doctor 2>&1", 1)
  end
end
