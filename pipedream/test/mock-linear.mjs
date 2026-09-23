/** Minimal in-memory stand-in for Linear's GraphQL API, for offline tests. */
import crypto from "crypto";

export function createMockLinear({ labels = ["Sauce Labs", "Automated Test", "Regression"] } = {}) {
  const issues = [];
  const comments = [];
  let counter = 0;

  const calls = [];

  async function fetchImpl(url, options) {
    const { query, variables } = JSON.parse(options.body);
    calls.push({ query: query.trim().split("\n")[1]?.trim() ?? "", variables });

    const ok = (data) => ({ json: async () => ({ data }) });

    if (query.includes("FindByFingerprint")) {
      const nodes = issues.filter(
        (i) => i.teamId === variables.teamId && String(i.description).includes(variables.fingerprint)
      );
      return ok({ issues: { nodes } });
    }

    if (query.includes("IssueById")) {
      return ok({ issue: issues.find((i) => i.id === variables.id) ?? null });
    }

    if (query.includes("RecentTeamIssues")) {
      const nodes = issues.filter((i) => i.teamId === variables.teamId);
      return ok({ issues: { nodes } });
    }

    if (query.includes("TeamLabels")) {
      return ok({
        team: { labels: { nodes: labels.map((name) => ({ id: `label_${slugish(name)}`, name })) } },
      });
    }

    if (query.includes("CreateIssue")) {
      counter += 1;
      const issue = {
        id: crypto.randomUUID(),
        identifier: `SAU-${100 + counter}`,
        url: `https://linear.app/saucelabs/issue/SAU-${100 + counter}`,
        title: variables.input.title,
        description: variables.input.description,
        labelIds: variables.input.labelIds ?? [],
        teamId: variables.input.teamId,
        state: { name: "Backlog", type: "backlog" },
        createdAt: new Date().toISOString(),
      };
      issues.push(issue);
      return ok({ issueCreate: { success: true, issue } });
    }

    if (query.includes("UpdateIssue")) {
      const issue = issues.find((i) => i.id === variables.id);
      if (!issue) throw new Error("mock: issue not found");
      Object.assign(issue, variables.input);
      return ok({ issueUpdate: { success: true, issue } });
    }

    if (query.includes("CreateComment")) {
      const comment = {
        id: crypto.randomUUID(),
        issueId: variables.input.issueId,
        body: variables.input.body,
        url: `https://linear.app/saucelabs/comment/${comments.length + 1}`,
      };
      comments.push(comment);
      return ok({ commentCreate: { success: true, comment } });
    }

    throw new Error(`mock: unhandled query\n${query}`);
  }

  return { fetchImpl, issues, comments, calls };
}

function slugish(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
