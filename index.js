#!/usr/bin/env node

const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Generate Customer Impact summary for a GitHub release
 * This script finds all client-impact labeled PRs in a release and generates
 * a customer-friendly summary using Google Gemini AI
 */
class CustomerImpactSummaryGenerator {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }

    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
    });
  }

  /**
   * Parse GitHub context from environment variables
   */
  getGitHubContext() {
    const context = {
      repo: {
        owner: process.env.GITHUB_REPOSITORY?.split("/")[0],
        repo: process.env.GITHUB_REPOSITORY?.split("/")[1],
      },
      release: {
        tag_name: process.env.RELEASE_TAG,
        name: process.env.RELEASE_NAME,
        id: process.env.RELEASE_ID,
        body: process.env.RELEASE_BODY || "",
      },
    };

    if (!context.repo.owner || !context.repo.repo) {
      throw new Error("Missing GitHub repository information");
    }

    if (!context.release.tag_name) {
      throw new Error("Missing release tag information");
    }

    return context;
  }

  /**
   * Get all releases to find the previous one for comparison
   */
  async getPreviousRelease(context, currentTag) {
    const releases = await this.octokit.rest.repos.listReleases({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: 10,
    });

    const currentIndex = releases.data.findIndex(
      (r) => r.tag_name === currentTag
    );
    return releases.data[currentIndex + 1] || null;
  }

  /**
   * Extract PR numbers from commit messages
   */
  extractPRNumbers(commits) {
    const prNumbers = new Set();

    commits.forEach((commit) => {
      const prMatch = commit.commit.message.match(/\(#(\d+)\)/);
      if (prMatch) {
        prNumbers.add(parseInt(prMatch[1], 10));
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

    // Get commits between releases
    const comparison = await this.octokit.rest.repos.compareCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      base: previousRelease.tag_name,
      head: context.release.tag_name,
    });

    const prNumbers = this.extractPRNumbers(comparison.data.commits);
    console.log(
      `Found ${prNumbers.length} PRs in release: ${prNumbers.join(", ")}`
    );

    // Fetch PR details
    const pullRequests = [];

    for (const prNumber of prNumbers) {
      try {
        const pr = await this.octokit.rest.pulls.get({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: prNumber,
        });
        pullRequests.push(pr.data);
      } catch (error) {
        console.log(`Could not fetch PR #${prNumber}: ${error.message}`);
      }
    }

    return pullRequests;
  }

  /**
   * Filter PRs that have client impact labels
   */
  filterClientImpactPRs(pullRequests) {
    const clientImpactLabels = [
      "client-impact",
      "customer-facing",
      "user-facing",
      "customer-impact",
    ];

    return pullRequests.filter((pr) =>
      pr.labels.some((label) =>
        clientImpactLabels.some((clientLabel) =>
          label.name.toLowerCase().includes(clientLabel.toLowerCase())
        )
      )
    );
  }

  /**
   * Build context string for Gemini from PR data
   */
  buildPRContext(clientImpactPRs) {
    return clientImpactPRs
      .map(
        (pr) => `
## PR #${pr.number}: ${pr.title}
**Author:** ${pr.user.login}
**Labels:** ${pr.labels.map((l) => l.name).join(", ")}
**Description:**
${pr.body || "No description provided"}

**Files Changed:** ${pr.changed_files} files
---
    `
      )
      .join("\n");
  }

  /**
   * Generate Customer Impact summary using Gemini AI
   */
  async generateSummary(clientImpactPRs, releaseName) {
    const prContext = this.buildPRContext(clientImpactPRs);

    const prompt = `
You are a technical translator helping a Customer Success team understand the client impact of software changes. 

Below are the details of ${clientImpactPRs.length} pull requests that were included in the "${releaseName}" release and marked as having client impact.

Please create a Customer Impact summary that:
1. Explains each change in non-technical language
2. Highlights the direct benefit to customers
3. Mentions any potential impact on customer support (fewer tickets, new features to demo, etc.)
4. Suggests key talking points for customer communications
5. Flags any changes that might require customer education or training

Keep the language friendly and business-focused, not technical. Focus on "what this means for our customers" rather than "how we built it."

Here are the pull requests:
${prContext}

Format your response as a clear, organized summary that the CS team can easily understand and act upon.
    `;

    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }

  /**
   * Update the release description with the Customer Impact summary
   */
  async updateReleaseDescription(context, summary, clientImpactPRs) {
    const csSummarySection = `

---

## 📋 Customer Impact Summary

*This summary covers ${
      clientImpactPRs.length
    } client-impacting changes in this release.*

${summary}

---

**Technical Details:** PRs included: ${clientImpactPRs
      .map((pr) => `#${pr.number}`)
      .join(", ")} | Generated: ${new Date().toISOString()}`;

    const updatedBody = context.release.body + csSummarySection;

    await this.octokit.rest.repos.updateRelease({
      owner: context.repo.owner,
      repo: context.repo.repo,
      release_id: parseInt(context.release.id, 10),
      body: updatedBody,
    });

    console.log("✅ Updated release description with Customer Impact summary");
  }

  /**
   * Add a notification comment to the release
   */
  async addNotificationComment(context, clientImpactPRs) {
    await this.octokit.rest.repos.createReleaseComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      release_id: parseInt(context.release.id, 10),
      body: `🤖 **Customer Impact Summary Added**

I've automatically added a customer impact summary to this release description covering ${clientImpactPRs.length} client-impacting changes.

The summary explains these changes in non-technical language for easy customer communication.

cc: @your-cs-team-member <!-- Replace with your CS team member's GitHub username -->`,
    });
  }

  /**
   * Main execution method
   */
  async run() {
    try {
      console.log("🚀 Starting Customer Impact Summary generation...");

      const context = this.getGitHubContext();
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
        `Found ${clientImpactPRs.length} client-impact PRs out of ${pullRequests.length} total PRs`
      );

      if (clientImpactPRs.length === 0) {
        console.log("ℹ️ No client-impact PRs found in this release");
        return;
      }

      const summary = await this.generateSummary(clientImpactPRs, releaseName);
      await this.updateReleaseDescription(context, summary, clientImpactPRs);
      await this.addNotificationComment(context, clientImpactPRs);

      console.log(
        "✅ Customer Impact Summary generation completed successfully"
      );
    } catch (error) {
      console.error("❌ Error generating Customer Impact summary:", error);
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
