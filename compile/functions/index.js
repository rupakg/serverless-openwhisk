'use strict';

const fs = require('fs-extra');
const BbPromise = require('bluebird');
const JSZip = require('jszip');
const Runtimes = require('./runtimes/index.js')

class OpenWhiskCompileFunctions {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('openwhisk');
    this.runtimes = new Runtimes(serverless)

    this.hooks = {
      'before:deploy:createDeploymentArtifacts': this.excludes.bind(this),
      'before:deploy:compileFunctions': this.setup.bind(this),
      'deploy:compileFunctions': this.compileFunctions.bind(this),
    };
  }

  // Ensure we don't bundle provider plugin with service artifact.
  excludes() {
    const exclude = this.serverless.service.package.exclude || [];
    exclude.push("node_modules/serverless-openwhisk/**");
    this.serverless.service.package.exclude = exclude;
  }

  setup() {
    // This object will be used to store the Action resources, passed directly to
    // the OpenWhisk SDK during the deploy process.
    this.serverless.service.actions = {};
   }

  calculateFunctionName(functionName, functionObject) {
    return functionObject.name || `${this.serverless.service.service}_${functionName}`;
  }

  calculateFunctionNameSpace(functionName, functionObject) {
    return functionObject.namespace || this.serverless.service.provider.namespace;
  }

  calculateMemorySize(functionObject) {
    return functionObject.memory || this.serverless.service.provider.memory || 256;
  }

  calculateTimeout(functionObject) {
    return functionObject.timeout || this.serverless.service.provider.timeout || 60;
  }

  calculateOverwrite(functionObject) {
    let Overwrite = true;

    if (functionObject.hasOwnProperty('overwrite')) {
      Overwrite = functionObject.overwrite;
    } else if (this.serverless.service.provider.hasOwnProperty('overwrite')) {
      Overwrite = this.serverless.service.provider.overwrite;
    }

    return Overwrite;
  }

  compileFunctionAction(params) {
    return {
      actionName: params.FunctionName,
      namespace: params.NameSpace,
      overwrite: params.Overwrite,
      action: {
        exec: params.Exec,
        limits: { timeout: params.Timeout * 1000, memory: params.MemorySize },
        parameters: params.Parameters,
        annotations: params.Annotations
      },
    };
  }

  // This method takes the function handler definition, parsed from the user's YAML file,
  // and turns it into the OpenWhisk Action resource object.
  //
  // These resource objects are passed to the OpenWhisk SDK to create the associated Actions
  // during the deployment process.
  //
  // Parameter values will be parsed from the user's YAML definition, either as a value from
  // the function handler definition or the service provider defaults.
  compileFunction(functionName, functionObject) {
    return this.runtimes.exec(functionObject).then(Exec => {
      const FunctionName = this.calculateFunctionName(functionName, functionObject);
      const NameSpace = this.calculateFunctionNameSpace(functionName, functionObject);
      const MemorySize = this.calculateMemorySize(functionObject);
      const Timeout = this.calculateTimeout(functionObject);
      const Overwrite = this.calculateOverwrite(functionObject);

      // optional action parameters
      const Parameters = Object.keys(functionObject.parameters || {})
        .map(key => ({ key, value: functionObject.parameters[key] }));
      
      // optional action annotations 
      const Annotations = Object.keys(functionObject.annotations || {})
        .map(key => ({ key, value: functionObject.annotations[key] }));

      return this.compileFunctionAction(
        { FunctionName, NameSpace, Overwrite, Exec, Timeout, MemorySize, Parameters, Annotations }
      );
    });
  }

  compileFunctions() {
    this.serverless.cli.log('Compiling Functions...');

    if (!this.serverless.service.actions) {
      throw new this.serverless.classes.Error(
        'Missing Resources section from OpenWhisk Resource Manager template');
    }

    const functionPromises = this.serverless.service.getAllFunctions().map((functionName) => {
      const functionObject = this.serverless.service.getFunction(functionName);

      if (!functionObject.handler && !functionObject.sequence) {
        throw new this.serverless.classes
          .Error(`Missing "handler" or "sequence" property in function ${functionName}`);
      }

      if (functionObject.handler && functionObject.sequence) {
        throw new this.serverless.classes
          .Error(`Found both "handler" and "sequence" properties in function ${functionName}, please choose one.`);
      }

      const functions = this.serverless.service.actions;
      const err = () => {
        throw new this.serverless.classes
          .Error(`Unable to read handler file in function ${functionName}`);
      };

      return this.compileFunction(functionName, functionObject)
        .then(newFunction => (functions[functionName] = newFunction))
        .catch(err);
    });

    return BbPromise.all(functionPromises);
  }
}

module.exports = OpenWhiskCompileFunctions;
