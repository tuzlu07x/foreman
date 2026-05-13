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
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/foreman --version")
    system bin/"foreman", "--help"
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
