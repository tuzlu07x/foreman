require "language/node"

class Foreman < Formula
  desc "Local AI agent gateway — mediates, scores, asks, and audits"
  homepage "https://github.com/tuzlu07x/foreman"
  url "https://registry.npmjs.org/foreman-agent/-/foreman-agent-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/tuzlu07x/foreman.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]

    # Generate + drop shell completions into the right Homebrew dirs.
    generate_completions_from_executable(bin/"foreman", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/foreman --version")
    system bin/"foreman", "--help"
    assert_match "complete -F", shell_output("#{bin}/foreman completion bash")
    assert_match "#compdef foreman", shell_output("#{bin}/foreman completion zsh")
    assert_match "foreman_no_subcommand", shell_output("#{bin}/foreman completion fish")
  end

  def caveats
    <<~EOS
      Foreman stores its state in ~/.foreman/ (identity key, policy.yaml,
      audit database). Reinstalling or upgrading does NOT touch it. Delete
      it manually if you want a clean slate:

          rm -rf ~/.foreman
    EOS
  end
end
