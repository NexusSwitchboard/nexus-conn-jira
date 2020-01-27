import {Client} from "jira.js";

import assert from "assert";
import moment from "moment";
import {Connection, ConnectionConfig} from "@nexus-switchboard/nexus-extend";

export type JiraTicket = {
    [index: string]: any;
};

export interface IJiraConfig {
    host: string;
    username: string;
    apiToken: string;
}

export class JiraConnection extends Connection {
    public api: Client;

    public name = "Jira";
    public config: IJiraConfig;

    protected priorityCache: any[];
    protected resolutionCache: any[];

    /**
     * Takes a typical Jira date string found in a response and returns it in a friendly string form.  This will
     * return one of two date formats:
     *
     *      * January 1st, 2019 at 12:43 pm
     *      * 6 days ago
     *
     * @param originalDateString The original date string (probably ISO)
     * @param relative If true, it returns something like "2 days ago" instead of the full date and time.
     */
    public friendlyDateString(originalDateString: string, relative: boolean = false): string {
        if (relative) {
            return moment(originalDateString).fromNow();
        } else {
            return moment(originalDateString).format("MMMM Do, YYYY [at] hh:mm a");
        }
    }

    /**
     * Converts a jira key to a fully qualified URL to use in a web browser
     * @param jiraHost The host with or without the scheme.  Without the scheme it will assume a secure endpoint with
     *              a https:// scheme.
     * @param key The jira key.
     */
    public keyToWebLink(jiraHost: string, key: string): string {
        assert(jiraHost, "Jira host not given in keyToWebLink method");
        assert(key, "Jira key not given in keyToWebLink method");

        if (jiraHost.trim().indexOf("http") < 0) {
            return `https://${jiraHost}/browse/${key}`;
        } else {
            return `${jiraHost}/browse/${key}`;
        }
    }

    /**
     * Atlassian uses Atlassian Document Format for fields that are capable of holding rich text.  This
     * method returns an ADF structure with basic defaults for a given text string.  For more information on
     * ADF: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
     *
     * @param text The text to embed in the structure
     * @param apiVersion
     */
    public transformDescriptionText(text: string, apiVersion: number): any {

        if (apiVersion === 3) {
            return {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                text,
                                type: "text"
                            }
                        ]
                    }
                ]
            };
        } else if (apiVersion === 2) {
            return text;
        } else {
            throw new Error("Unknown API version given for text transformation function");
        }

    }

    /**
     * This will make a request to Jira if one has not already been made (by the active "thread").  It will then
     * search the results looking for a case-insensitive match against the priority cache items' name field.  It will
     * either return the match or undefined if not found.
     * @param name The name to search for (case-insensitive).
     * @return The priority ID if found or undefined if not found.
     */
    public async getPriorityIdFromName(name: string): Promise<number> {
        if (!this.priorityCache) {
            this.priorityCache = await this.api.issuePriorities.getPriorities();
        }

        const priority = this.priorityCache.find((p) => p.name.toLowerCase() === name.toLowerCase());
        return priority ? priority.id : undefined;
    }

    /**
     * This will make a request to Jira if one has not already been made (by the active "thread").  It will then
     * search the results looking for a case-insensitive match against the resolution cache items' name field.  It will
     * either return the match or undefined if not found.
     * @param name The name to search for (case-insensitive).
     * @return The resolution ID if found or undefined if not found.
     * @param name
     */
    public async getResolutionIdFromName(name: string): Promise<number> {
        if (!this.resolutionCache) {
            this.resolutionCache = await this.api.issueResolutions.getResolutions();
        }

        const res = this.resolutionCache.find((p) => p.name.toLowerCase() === name.toLowerCase());
        return res ? res.id : undefined;
    }

    public connect(): JiraConnection {
        this.priorityCache = null;
        this.resolutionCache = null;

        this.api = new Client({
            host: this.config.host,
            authentication: {
                basic: {
                    username: this.config.username,
                    apiToken: this.config.apiToken
                }
            }
        });

        return this;
    }

    public disconnect(): boolean {
        delete this.api;
        return true;
    }
}

export default function createConnection(cfg: ConnectionConfig): Connection {
    return new JiraConnection(cfg);
}
