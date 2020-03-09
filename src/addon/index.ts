import { IRouter, NextFunction, Request, Response } from "express";
import Keyv from "keyv";
import { Application, Router } from "express";
import authenticationMiddleware from "./auth";
import { IWebhookPayload, logger } from "../index";
import bodyParser from "body-parser";

export const BASE_PATH_ADDON = "/jira/addon";


// To see webhook payload possibilities, sees
//  https://developer.atlassian.com/cloud/jira/platform/webhooks/#example-callback-for-an-issue-related-event
type JiraWebhookHandler = (
    payload: IWebhookPayload
) => Promise<boolean>

export interface IDescriptorModule {
    key?: string
    description?: string
}

export interface IWebhookDefinition extends IDescriptorModule {
    event: string
    url?: string
    excludeBody?: boolean
    filter?: string
    propertyKeys?: string[]
}

export type WebhookConfiguration = {
    definition: IWebhookDefinition,
    handler: JiraWebhookHandler
}

export interface IAtlassianDescriptor {
    key: string;
    name?: string;
    authentication: {
        type: string // 'jwt' | 'JWT' | 'none' | 'NONE'
    };
    baseUrl: string;

    modules?: {
        [index: string]: IDescriptorModule[],
    }

    description?: string;
    vendor?: {
        name: string;
        url: string;
    };
    links?: {
        self: string;
    };
    lifecycle?: {
        installed: string;
        uninstalled: string;
    };
    enableLicensing?: boolean;
    scopes?: string[];

    maxTokenAge?: number;
}


export class AtlassianAddon {

    readonly subApp: Application;

    public descriptorData: IAtlassianDescriptor;

    // The max token age is the length of time in seconds, after which the
    //  token should be  considered invalid.
    protected _maxTokenAge: number;

    protected db: Keyv;
    protected metaRouter: IRouter;


    public constructor(params: IAtlassianDescriptor, subApp: Application,
                       dbConnectionString?: string, maxTokenAge?: number) {

        const defaults = {
            scopes: [
                "read", "write"
            ]
        };

        this._maxTokenAge = maxTokenAge || 15 * 60;

        // The descriptor data that was passed in here will be used
        //  to output the  JSON requested by Jira when installing or getting
        //  information about the addon.
        this.descriptorData = Object.assign({}, defaults, params);

        // Modify the baseUrl to include the jira addon portion.  This will be used as the stem for all
        //  calls  into this  addon so it  should include the BASE_PATH_ADDON portion at the beginning.
        this.descriptorData.baseUrl += BASE_PATH_ADDON;

        this.subApp = subApp;

        // If no connection string is given then we will assume  that we
        //  are using  sqlite db in place here.
        if (!dbConnectionString) {
            dbConnectionString = "sqlite://addon.sqlite";
        }

        // Initialize  the  database that will be holding the client information.
        //  Note that  the client information will be keyed on the client
        //  key which will be given at the time of installation of the
        //  addon.  The client details  are used to decode JWTs that  are
        //  passed in during callback (like webhooks).
        this.db = new Keyv(dbConnectionString, {namespace:"jira-conn-addon"});

        // Ensure that we we  have the lifecycle endpoints created a
        //  and  ready to accept install/uninstall  and descriptor requests.
        this.addLifecycleEndpoints();
    }

    get maxTokenAge(): number {
        return this._maxTokenAge;
    }

    get app(): Application {
        return this.subApp;
    }

    get name(): string {
        return this.descriptorData.name;
    }

    get key(): string {
        return this.descriptorData.key;
    }

    get baseUrl(): string {
        return this.descriptorData.baseUrl;
    }

    get description(): string {
        return this.descriptorData.description;
    }

    get scopes(): string[] {
        return this.descriptorData.scopes;
    }

    get skipQshVerification(): boolean {
        return true;
    }

    protected async getClientData(clientKey: string, key: string) {
        const data = await this.db.get(clientKey);
        if (data && key in data) {
            return data[key];
        } else {
            return undefined;
        }
    }

    static sendError(code: number, msg: string, res: Response) {
        res.status(code).json({ code, msg });
    }

    public async getSharedSecret(clientKey: string): Promise<string> {
        return this.getClientData(clientKey, "sharedSecret");
    }

    /**
     * This will add the installed and uninstalled handlers to the stored router
     * and automatically add/remove the client information to/from storage.
     *
     * After this is returned there will be an /installed and an /uninstalled
     * endpoint at the root of the  given router.
     */
    public addLifecycleEndpoints() {

        if (this.metaRouter) {
            logger("Trying to reinitialize lifecycle endpoints.   Skipping...");
            return;
        }

        // The meta router is the root for the endpoints used for
        //  installation, uninstallation and descriptor requests from Jira.
        this.metaRouter = Router();
        // Ensure that JSON payload bodies are parsed and ready for usage by
        //  all downstream routes.
        this.metaRouter.use(bodyParser.json());
        this.subApp.use(`${BASE_PATH_ADDON}/meta`, this.metaRouter);

        //// this builds out the lifecycle property of the descriptor.  Done this
        //  way to reduce the logic involved in checking whether one, both or neither
        //  of the lifecycle properties exist.s
        this.descriptorData.lifecycle = {
            installed: "/meta/installed",
            uninstalled: "/meta/uninstalled"
        };

        //// SETUP INSTALLED CALLBACK
        this.metaRouter.post("/installed", async (req: Request, res: Response) => {
            const clientData = req.body;
            if (!clientData || !clientData.clientKey) {
                return AtlassianAddon.sendError(500,"Received malformed installation payload from Jira", res);
            }

            await this.db.set(clientData.clientKey, clientData);
            return AtlassianAddon.sendError(200, "Installation completed successfully", res);
        });

        //// SETUP UNINSTALLED CALLBACK
        this.metaRouter.post("/uninstalled", async (req: Request, res: Response) => {
            const clientData = req.body;
            if (!clientData || !clientData.clientKey) {
                return AtlassianAddon.sendError(500, "Received malformed installation payload from Jira", res );
            }
            await this.db.delete(clientData.clientKey);
            return AtlassianAddon.sendError(200, "Uninstall completed successfully", res);
        });

        //// DESCRIPTOR ENDPOINT
        this.metaRouter.get(
            `/descriptor`,
            (_req, res: Response) => {
                res.json(this.toJson());
            }
        );
    }

    /**
     * This will add the given webhooks and install a new request handler
     * on the stored route router.
     * @param webhooks
     */
    public addWebhooks(webhooks: WebhookConfiguration[]) {

        const base = `/webhook`;
        const route = `${BASE_PATH_ADDON}${base}/:event`;

        /**
         * What's happening here:
         *  1. Ensure the descriptor data exposes the correct values
         *      by including the webhooks specified in the given configuration
         *      The `definition` part of the configuration should map to the
         *      same shape as specified in the webhook portion of the app
         *      descriptor:
         *          https://developer.atlassian.com/cloud/jira/platform/modules/webhook/
         *
         *  2. The URL is being calculated for you.  So if the configuration
         *      contains a url it will be replaced.
         */
        if (!this.descriptorData.modules) {
            this.descriptorData.modules = {};
        }
        if (!this.descriptorData.modules.webhooks) {
            this.descriptorData.modules.webhooks = [];
        }
        webhooks.forEach((wh: WebhookConfiguration) => {
            wh.definition.url = `${base}/${wh.definition.event}`;
            this.descriptorData.modules.webhooks.push(wh.definition);
        });

        /**
         * This is the request handler for the actual webhook events.
         *  Notes:
         *      1. The authentication middleware verifies the payload
         *          by decoding the jwt, extracting the client key
         *          and verifying the payload with the shared secret.
         *      2. If successfully verified then this will call the handler
         *          specified during initialization in the WebhookConfiguration
         *          typed properties in the connection configuration.
         */
        this.subApp.post(route,
            bodyParser.json(),
            authenticationMiddleware(this),
            async (req: Request, res: Response, next: NextFunction) => {

                const event = req.params.event;
                if (!event) {
                    const msg = "Received an event from Jira but the event parameter was not set which suggests that the URL was setup incorrectly";
                    logger(msg);
                    next(new Error(msg));
                }

                try {
                    if (!req.body) {
                        logger("Received a webhook event but no pre-processing of the body has been done.  Make sure and add a body parser middleware to the route");
                        return;
                    }

                    const payload: IWebhookPayload = req.body;

                    // Do a search of the stored webhook configurations looking
                    //  for the one with the matching event name.  If found, then
                    //  call the handler, otherwise return a
                    const index = webhooks.findIndex((wh) => wh.definition.event === payload.webhookEvent);
                    if (index >= 0) {
                        await webhooks[index].handler(payload);
                        return AtlassianAddon.sendError(200, "Event handled successfully", res);
                    } else {
                        logger(`Webhook event handler not found for ${req.body.event}`);
                        return AtlassianAddon.sendError(404, "Event handler not found", res);
                    }
                } catch (e) {
                    logger("Unable to handle a webhook event that  was received from Jira: " + e.toString());
                    return AtlassianAddon.sendError(500, "Exception thrown during handling of webhook event", res);
                }
            });
    }

    public toJson() {
        return this.descriptorData;
    }
}
