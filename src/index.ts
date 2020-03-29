import { Client } from 'jira.js';
import { Application, Request, Response } from 'express';
import assert from 'assert';
import moment from 'moment';
import { Connection, ConnectionConfig, GlobalConfig } from '@nexus-switchboard/nexus-extend';
import { AtlassianAddon, WebhookConfiguration } from "atlassian-addon-helper"
import debug from 'debug';

export const logger = debug('nexus:jira');

export type JiraTicket = {
    [index: string]: any
}

export type JiraPayload = {
    [index: string]: any
}


export interface IJiraConfig {
    host: string;
    username: string;
    apiToken: string;

    // This is required if you are adding functionality that requires that a Jira instance communicate
    // with this module (webhooks, for example).
    subApp?: Application;

    // If the name and key are not filled in then an addon will not
    //  be  created.  Otherwise, a new AtlassianAddon object will be
    //  created and instantiated  under the addon property of this JiraConnection
    //  instance.
    addon?:  {
        key: string;
        name:  string;
        description?: string;
    };

    // If there are any settings that would cause this connection to expose endpoints, then
    //  this is the base URL expected for that endpoint.  This is expected to be everything before the portion
    //  of the path that will be handled by the connection.  In other words, it might be something like this:
    //      https://mydomain.com/m/mymod
    baseUrl?: string;

    // A list of webhooks to register for.
    //  https://developer.atlassian.com/cloud/jira/platform/modules/webhook/
    webhooks: WebhookConfiguration[];

    // The key/value store to use with keyv to store persistant data. Note that this can be either redis or
    //  SQLite and the connection string docs are available here: https://github.com/lukechilds/keyv
    connectionString: string;
}

/**
 * The  Jira connection object is capable of hosting an Addon server but also
 * connects and exposes the REST API for Jira.  In this capacity, it makes public
 * a property called "api" which is an instance of the jira.js client library.
 * Information at the  library is available here:
 *  https://jira-node.github.io/
 *
 *  An addon, at a minimum needs a unique key and a name.  But for it actually
 *      do something you will need to fill in the IJiraConfig prop with
 *      Jira module extensions (like webhooks or something else that can only
 *      be done by an addon).
 */
export class JiraConnection extends Connection {
    public api: Client;

    public name = 'Jira';
    public config: IJiraConfig;
    public addon: AtlassianAddon;

    protected priorityCache: any[];
    protected resolutionCache: any[];

    public connect(): JiraConnection {
        this.priorityCache = null;
        this.resolutionCache = null;

        // REST API Connectivity
        this.api = new Client({
            host: this.config.host,
            authentication: {
                basic: {
                    username: this.config.username,
                    apiToken: this.config.apiToken
                }
            }
        });

        // JIRA Add-On Setup
        this.setupAddon();

        return this;
    }

    public disconnect(): boolean {
        delete this.api;
        return true;
    }

    /**
     * If the Jira configuration given has any indication that this will act as a Jira Add-On
     * (meaning) that it has something like webhooks specified, then this will setup the connection
     * to be able to receive requests from Jira.
     *
     * The Atlassian Addon (Connect) Descriptor is a well-defined object that is returned from
     * a known endpoint for this addon.  Information about the addon can be found here:
     *  https://developer.atlassian.com/cloud/jira/platform/app-descriptor/
     *
     * The endpoints from the addon setup are as follows:
     *
     *  Webhooks:
     *      POST ${config.addon.baseUrl}/${BASE_PATH_ADDON}/webhooks/${event-name}
     *
     *  Descriptor:
     *      GET ${config.addon.baseUrl}/${BASE_PATH_ADDON}/addon
     */
    public setupAddon() {

        if (!this.config.addon) {
            return;
        }

        // Now create the addon object which handles constructing the addon as
        //  expected by Jira.
        this.addon = new AtlassianAddon( {
            key: this.config.addon.key,
            baseUrl: this.config.baseUrl,
            authentication: {
                type: 'jwt'
            }},
            this.config.subApp,
            "/jira/addon",
            this.config.connectionString
        );

        if (this.config.webhooks) {

            this.addon.addWebhooks(this.config.webhooks);
        }

        this.config.subApp.get('/test', (_req: Request, res: Response) => {
            res.send('Hello world!');
        });
    }

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
    public friendlyDateString(
        originalDateString: string,
        relative: boolean = false
    ): string {
        if (relative) {
            return moment(originalDateString).fromNow();
        } else {
            return moment(originalDateString).format(
                'MMMM Do, YYYY [at] hh:mm a'
            );
        }
    }

    /**
     * Converts a jira key to a fully qualified URL to use in a web browser
     * @param jiraHost The host with or without the scheme.  Without the scheme it will assume a secure endpoint with
     *              a https:// scheme.
     * @param key The jira key.
     */
    public keyToWebLink(jiraHost: string, key: string): string {
        assert(jiraHost, 'Jira host not given in keyToWebLink method');
        assert(key, 'Jira key not given in keyToWebLink method');

        if (jiraHost.trim().indexOf('http') < 0) {
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
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                text,
                                type: 'text'
                            }
                        ]
                    }
                ]
            };
        } else if (apiVersion === 2) {
            return text;
        } else {
            throw new Error(
                'Unknown API version given for text transformation function'
            );
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

        const priority = this.priorityCache.find(
            p => p.name.toLowerCase() === name.toLowerCase()
        );
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

        const res = this.resolutionCache.find(
            p => p.name.toLowerCase() === name.toLowerCase()
        );
        return res ? res.id : undefined;
    }
}

export default function createConnection(cfg: ConnectionConfig, globalCfg: GlobalConfig): Connection {
    return new JiraConnection(cfg, globalCfg);
}
