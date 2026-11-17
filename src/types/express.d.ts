import { AuthenticatedUser } from './index';

//declare express request user
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      file?: any;
    }
  }
}
