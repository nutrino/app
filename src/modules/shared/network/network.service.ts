import { Injectable } from 'angular-ts-decorators';
import {
  BaseError,
  HttpRequestAbortedError,
  HttpRequestFailedError,
  HttpRequestTimedOutError,
  NetworkConnectionError
} from '../errors/errors';

@Injectable('NetworkService')
export class NetworkService {
  private $q: ng.IQService;

  static $inject = ['$q'];
  constructor($q: ng.IQService) {
    this.$q = $q;
  }

  checkNetworkConnection(): ng.IPromise<void> {
    return this.$q((resolve, reject) => {
      if (this.isNetworkConnected()) {
        return resolve();
      }
      reject(new NetworkConnectionError());
    });
  }

  getErrorFromHttpResponse(response: ng.IHttpResponse<unknown>): BaseError {
    let error: BaseError;
    switch (true) {
      // Request timed out
      case response.xhrStatus === 'timeout':
        error = new HttpRequestTimedOutError();
        break;
      // Request timed out
      case response.xhrStatus === 'abort':
        error = new HttpRequestAbortedError();
        break;
      // Otherwise generic request failed
      default:
        error = new HttpRequestFailedError(`status: ${response.status}`);
    }
    return error;
  }

  isNetworkConnected(): boolean {
    const connectionTypes = typeof window !== 'undefined' && (window as any).Connection;
    const connection = (navigator as any).connection;
    return connectionTypes && connection?.type
      ? connection.type !== connectionTypes.NONE && connection.type !== connectionTypes.UNKNOWN
      : navigator.onLine;
  }

  isNetworkConnectionError(err: Error): boolean {
    return err instanceof HttpRequestTimedOutError || err instanceof NetworkConnectionError;
  }
}
