#!/usr/bin/env node

const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const core = require("@actions/core");

/**
 * Generate Customer Impact summary for a GitHub release
 * This script finds all client-impact labeled PRs in a release and generates
 * a customer-friendly summary using Google Gemini AI
 */
class CustomerImpactSummaryGenerator {
  constructor() {
    // Get inputs from GitHub Action or environment variables
    const githubToken =
      core.getInput("github_token").trim() || process.env.GITHUB_TOKEN;
    const geminiApiKey =
      core.getInput("google_gemini_api_key").trim() ||
      process.env.GOOGLE_GEMINI_API_KEY;

    console.log(`GitHub token available: ${githubToken ? "Yes" : "No"}`);
    console.log(`Gemini API key available: ${geminiApiKey ? "Yes" : "No"}`);

    if (!githubToken) {
      throw new Error(
        "GitHub token is required (github_token input or GITHUB_TOKEN environment variable)"
      );
    }

    this.octokit = new Octokit({
      auth: githubToken,
    });

    if (!geminiApiKey) {
      throw new Error(
        "Google Gemini API key is required (google_gemini_api_key input or GOOGLE_GEMINI_API_KEY environment variable)"
      );
    }

    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.model = this.genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `<role>You are a technical translator helping a Customer Success team understand the client impact of software changes.</role>

<task>
Your role is to create Customer Impact summaries that:
1. Explain each change in non-technical language
2. Highlight the direct benefit to customers
3. Mention any potential impact on customer support (fewer tickets, new features to demo, etc.)
4. Suggest key talking points for customer communications
5. Flag any changes that might require customer education or training
</task>

<guidelines>
Keep the language friendly and business-focused, not technical. Focus on "what this means for our customers" rather than "how we built it."

Before getting started, make sure to adhere to the following output guidelines:
- Start directly with the summary content. Avoid writing an initial header or title,preamble, acknowledgment, or phrases like "Here is the summary" or "Of course".
- Just provide the organized summary that the CS team can use and act upon immediately.
</guidelines>`,
    });
  }

  /**
   * Parse GitHub context from environment variables
   */
  async getGitHubContext() {
    const context = {
      repo: {
        owner: process.env.GITHUB_REPOSITORY?.split("/")[0],
        repo: process.env.GITHUB_REPOSITORY?.split("/")[1],
      },
    };

    if (!context.repo.owner || !context.repo.repo) {
      throw new Error("Missing GitHub repository information");
    }

    // Always look for the latest draft release
    console.log("Looking for latest draft release...");

    const releases = await this.octokit.rest.repos.listReleases({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: 50,
    });

    const draftRelease = releases.data.find((release) => release.draft);

    if (!draftRelease) {
      throw new Error("No draft release found");
    }

    console.log(
      `Found draft release: ${draftRelease.name || draftRelease.tag_name}`
    );

    context.release = {
      tag_name: draftRelease.tag_name,
      name: draftRelease.name,
      id: draftRelease.id.toString(),
      body: draftRelease.body || "",
    };

    return context;
  }

  /**
   * Get all releases to find the previous one for comparison
   */
  async getPreviousRelease(context, currentTag) {
    const releases = await this.octokit.rest.repos.listReleases({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: 50,
    });

    // Filter out draft releases to find the latest published release
    const publishedReleases = releases.data.filter((release) => !release.draft);

    // For a draft release, the previous release is the latest published release
    return publishedReleases[0] || null;
  }

  /**
   * Extract PR numbers from commit messages
   */
  extractPRNumbers(commits) {
    const prNumbers = new Set();

    console.log("Extracting PR numbers from commit messages...");
    commits.forEach((commit, index) => {
      const message = commit.commit.message;

      // Look for PR numbers in merge commit messages: "Merge pull request #123 from..."
      // But exclude PRs from development branch
      const mergeMatch = message.match(/Merge pull request #(\d+)/);
      const isDevelopmentPR = message.includes("from umanai/development");

      let prNumber = null;
      if (mergeMatch && !isDevelopmentPR) {
        prNumber = parseInt(mergeMatch[1], 10);
      }

      if (prNumber) {
        prNumbers.add(prNumber);
        console.log(
          `  Found PR #${prNumber} in commit: ${message.split("\n")[0]}`
        );
      } else {
        // Debug: Show commits that don't match the pattern or are excluded
        if (mergeMatch && isDevelopmentPR) {
          console.log(
            `  Skipped development PR #${mergeMatch[1]} in: ${
              message.split("\n")[0]
            }`
          );
        } else {
          console.log(`  No PR found in: ${message.split("\n")[0]}`);
        }
      }
    });

    return [...prNumbers];
  }

  /**
   * Get all PRs included in the release since the previous release
   */
  async getPRsInRelease(context, previousRelease) {
    if (!previousRelease) {
      console.log("No previous release found, skipping PR collection");
      return [];
    }

    console.log(
      `Getting PRs since previous release: ${previousRelease.tag_name}`
    );

    try {
      // Use the current commit SHA from the workflow context
      const currentCommitSha = process.env.GITHUB_SHA || "HEAD";
      console.log(`Comparing against current commit: ${currentCommitSha}`);

      const comparison = await this.octokit.rest.repos.compareCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: previousRelease.tag_name,
        head: currentCommitSha,
      });

      console.log(`Comparison found ${comparison.data.commits.length} commits`);

      // Debug: Show all commit messages
      if (comparison.data.commits.length > 0) {
        console.log("All commit messages:");
        comparison.data.commits.forEach((commit, index) => {
          console.log(
            `  ${index + 1}. ${commit.commit.message.split("\n")[0]}`
          );
        });
      }

      const prNumbers = this.extractPRNumbers(comparison.data.commits);
      console.log(
        `Extracted ${prNumbers.length} PR numbers: ${prNumbers.join(", ")}`
      );

      if (prNumbers.length === 0 && comparison.data.commits.length > 0) {
        console.log(
          "⚠️  No PR numbers found in commit messages. Commit messages might not follow (#123) format"
        );
      }

      // Fetch PR details with file diffs
      const pullRequests = [];

      for (const prNumber of prNumbers) {
        try {
          const pr = await this.octokit.rest.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
          });

          // Get the files changed in this PR with diffs
          const files = await this.octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
          });

          // Add the files/diffs to the PR data
          pr.data.files = files.data;
          pullRequests.push(pr.data);
        } catch (error) {
          console.log(`Could not fetch PR #${prNumber}: ${error.message}`);
        }
      }

      return pullRequests;
    } catch (error) {
      console.log(`Could not compare commits: ${error.message}`);
      return [];
    }
  }

  /**
   * Filter PRs that have client impact labels
   */
  filterClientImpactPRs(pullRequests) {
    return pullRequests.filter((pr) =>
      pr.labels.some((label) =>
        label.name.toLowerCase().includes("customer impact")
      )
    );
  }

  /**
   * Count tokens using Gemini's built-in token counter
   */
  async countTokens(text) {
    const tokenCount = await this.model.countTokens(text);
    return tokenCount.totalTokens;
  }

  /**
   * Build context string for Gemini from PR data
   */
  buildPRContext(clientImpactPRs, includeDiffs = true) {
    return clientImpactPRs
      .map((pr) => {
        let context = `
## PR #${pr.number}: ${pr.title}
**Author:** ${pr.user.login}
**Labels:** ${pr.labels.map((l) => l.name).join(", ")}
**Description:**
${pr.body || "No description provided"}

**Files Changed:** ${pr.changed_files} files
`;

        // Add file diffs if available and requested
        if (includeDiffs && pr.files && pr.files.length > 0) {
          context += "\n**File Changes:**\n";
          pr.files.forEach((file) => {
            context += `\n### ${file.filename} (${file.status})\n`;
            context += `**Changes:** +${file.additions} -${file.deletions}\n`;

            // Include the patch/diff if available and not too large
            if (file.patch && file.patch.length < 2000) {
              context += "**Diff:**\n```diff\n" + file.patch + "\n```\n";
            } else if (file.patch) {
              context +=
                "**Diff:** (too large to include, " +
                file.patch.length +
                " characters)\n";
            }
          });
        } else if (!includeDiffs && pr.files && pr.files.length > 0) {
          // Just show file list without diffs
          context += "\n**Files Changed:**\n";
          pr.files.forEach((file) => {
            context += `- ${file.filename} (${file.status}, +${file.additions} -${file.deletions})\n`;
          });
        }

        context += "\n---\n";
        return context;
      })
      .join("\n");
  }

  /**
   * Generate Customer Impact summary using Gemini AI
   */
  async generateSummary(clientImpactPRs, releaseName) {
    // Try with full context first (including diffs)
    let prContext = this.buildPRContext(clientImpactPRs, true);
    let prompt = `Below are the details of ${clientImpactPRs.length} pull requests that were included in the "${releaseName}" release and marked as having client impact.

Here are the pull requests:
${prContext}`;

    // Count tokens and fallback if needed
    const tokenCount = await this.countTokens(prompt);
    const maxTokens = 1000000; // 1M token limit

    console.log(`Actual token count: ${tokenCount.toLocaleString()}`);

    if (tokenCount > maxTokens) {
      console.log(
        `⚠️  Token count (${tokenCount.toLocaleString()}) exceeds limit (${maxTokens.toLocaleString()})`
      );
      console.log("Regenerating prompt without file diffs...");

      // Regenerate without diffs
      prContext = this.buildPRContext(clientImpactPRs, false);
      prompt = `Below are the details of ${clientImpactPRs.length} pull requests that were included in the "${releaseName}" release and marked as having client impact.

Here are the pull requests:
${prContext}`;

      const newTokenCount = await this.countTokens(prompt);
      console.log(
        `New token count without diffs: ${newTokenCount.toLocaleString()}`
      );

      if (newTokenCount > maxTokens) {
        throw new Error(
          `Token count still exceeds limit even without diffs: ${newTokenCount.toLocaleString()}`
        );
      }
    }

    console.log("=".repeat(80));
    console.log("FULL PROMPT BEING SENT TO GEMINI:");
    console.log("=".repeat(80));
    console.log(prompt);
    console.log("=".repeat(80));
    console.log("END OF PROMPT");
    console.log("=".repeat(80));

    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }

  /**
   * Update the release description with the Customer Impact summary
   */
  async updateReleaseDescription(context, summary, clientImpactPRs) {
    const csSummarySection = `<details>
<summary>📋 Customer Impact Summary</summary>

${summary}

</details>

---

`;

    // Insert the customer impact summary at the top, keeping existing content at the bottom
    const updatedBody = csSummarySection + (context.release.body || "");

    await this.octokit.rest.repos.updateRelease({
      owner: context.repo.owner,
      repo: context.repo.repo,
      release_id: parseInt(context.release.id, 10),
      body: updatedBody,
    });

    console.log("✅ Updated release description with Customer Impact summary");
  }

  /**
   * Main execution method
   */
  async run() {
    try {
      console.log("🚀 Starting Customer Impact Summary generation...");

      const context = await this.getGitHubContext();
      const releaseName = context.release.name || context.release.tag_name;

      console.log(
        `Processing release: ${releaseName} (${context.release.tag_name})`
      );

      const previousRelease = await this.getPreviousRelease(
        context,
        context.release.tag_name
      );
      const pullRequests = await this.getPRsInRelease(context, previousRelease);
      const clientImpactPRs = this.filterClientImpactPRs(pullRequests);

      console.log(
        `Found ${clientImpactPRs.length} customer-impact PRs out of ${pullRequests.length} total PRs`
      );

      if (clientImpactPRs.length === 0) {
        console.log("ℹ️ No customer-impact PRs found in this release");
        return;
      }

      const summary = await this.generateSummary(clientImpactPRs, releaseName);
      await this.updateReleaseDescription(context, summary, clientImpactPRs);

      console.log(
        "✅ Customer Impact Summary generation completed successfully"
      );
    } catch (error) {
      console.error("❌ Error generating Customer Impact summary:", error);
      core.setFailed(error.message);
      process.exit(1);
    }
  }
}

// Run the script if called directly
if (require.main === module) {
  const generator = new CustomerImpactSummaryGenerator();
  generator.run();
}

module.exports = CustomerImpactSummaryGenerator;
