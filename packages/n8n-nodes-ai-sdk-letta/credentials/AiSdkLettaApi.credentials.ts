import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * An automation token of an ai-sdk-letta server (Automations in its app),
 * and where the server's automation API is. The token is sent as a bearer
 * token; n8n stores it encrypted.
 */
export class AiSdkLettaApi implements ICredentialType {
	name = 'aiSdkLettaApi';

	displayName = 'ai-sdk-letta API';

	icon = 'file:../icons/aiSdkLetta.svg' as const;

	documentationUrl = 'https://github.com/leonardschneider/ai-sdk-letta/tree/main/packages/n8n-nodes-ai-sdk-letta#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'http://host.docker.internal:4402',
			placeholder: 'http://host.docker.internal:4402',
			description: 'The automation API of the ai-sdk-letta server. From n8n in Docker on the same machine, use host.docker.internal and the automation port.',
			required: true,
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'lta_…',
			description: 'Create one in the ai-sdk-letta app: Automations → New token (used by n8n). It is shown once.',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.token}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\/+$/, "")}}',
			url: '/v1/automation/whoami',
			method: 'GET',
		},
	};
}
