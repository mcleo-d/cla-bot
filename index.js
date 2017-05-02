const ursa = require('ursa');
const fs = require('fs');

const privateKey = ursa.createPrivateKey(fs.readFileSync('clabotkey.pem'));
const defaultConfig = JSON.parse(fs.readFileSync('default.json'));

const getReadmeUrl = (context) => ({
  url: context.webhook.repository.url + '/contents/.clabot',
  method: 'GET'
});

const getReadmeContents = (body) => ({
  url: body.download_url,
  method: 'GET'
});

const addLabel = (context) => ({
  url: context.webhook.pull_request.issue_url + '/labels',
  body: [context.config.label]
});

const setStatus = (context, state) => ({
  url: context.webhook.repository.url + '/statuses/' + context.webhook.pull_request.head.sha,
  body: {
    state,
    context: 'verification/cla-signed'
  }
});

const addComment = (context) => ({
  url: context.webhook.pull_request.issue_url + '/comments',
  body: {
    body: context.config.message
  }
});

exports.handler = ({ body }, lambdaContext, callback, request) => {
  // TODO: log callback invocations
  if (body.action !== 'opened') {
    callback(null, {'message': 'ignored action of type ' + body.action});
    return;
  }

  const clabotToken = process.env.GITHUB_ACCESS_TOKEN;
  const user = body.pull_request.user.login;
  const context = {
    webhook: body
  };

  console.log(`Checking CLA for user ${user} and repository ${body.repository.url}`);

  // for test purposes we pass in a mocked request object
  request = request || require('request');

  // adapts the request API to provide generic handling of HTTP / transport errors and
  // error responses from the GitHub API.
  const githubRequest = (opts, token = clabotToken) => new Promise((resolve, reject) => {
    // merge the standard set of HTTP request options
    const mergedOptions = Object.assign({}, {
      json: true,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'github-cla-bot'
      },
      method: 'POST'
    }, opts);

    // perform the request
    console.log('GitHub API Request', opts.url);
    request(mergedOptions, (error, response, body) => {
      if (error) {
        // TODO: does this reveal anything sensitive to the client? (i.e. the webhook)
        reject(error.toString());
      } else if (response && response.statusCode && !response.statusCode.toString().startsWith('2')) {
        // TODO: does this reveal anything sensitive to the client? (i.e. the webhook)
        reject(new Error('GitHub API request failed with status ' + response.statusCode));
      } else {
        resolve(body);
      }
    });
  });

  githubRequest(getReadmeUrl(context))
    .then(body => githubRequest(getReadmeContents(body)))
    .then(config => {

      context.config = Object.assign({}, defaultConfig, config);

      const userToken = privateKey.decrypt(config.token, 'base64', 'utf8');

      if (config.contributors.indexOf(user) !== -1) {
        // TODO: what if the label doesn't exists?
        return githubRequest(addLabel(context), userToken)
          .then(() => githubRequest(setStatus(context, 'success'), userToken))
          .then(() => callback(null, {'message': `added label ${context.config.label} to ${body.repository.url}`}));
      } else {
        return githubRequest(addComment(context))
          .then(() => githubRequest(setStatus(context, 'failure'), userToken))
          .then(() => callback(null, {'message': `CLA has not been signed by ${user}, added a comment to ${body.repository.url}`}));
      }
    })
    .catch((err) => {
      callback(err.toString());
    });
};
