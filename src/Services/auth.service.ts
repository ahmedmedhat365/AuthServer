import bcrypt from "bcryptjs";
import crypto from "crypto";
import moment from "moment";
import { sign as jwtSign, verify as jwtVerify } from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { Request } from "express";
import axios from "axios";
import querystring from "querystring";

import { UserModel as User, UserInterface } from "../Models/user.model";
import { UserSessionModel as UserSession } from "../Models/userSession.model";

import { sendEmail } from "../Utils/sendEmail.util";
import Token from "../Models/tokenResetPassword.model";
import { calculateExpirationDate } from "../Config/calculateExpirationDate";
import readTemplate from "../Utils/readTemplate.util";




export async function registerService(
  firstName: string,
  lastName: string,
  email: string,
  password: string
) {
  const hashPassword = await bcrypt.hash(
    password,
    parseInt(process.env.SALT_ROUND)
  );

  const newUser = new User({
    firstName,
    lastName,
    email,
    password: hashPassword,
  });
  const savedUser = await newUser.save();

  if (!savedUser) {
    return {
      isSuccess: false,
      message: "Sorry, Please try to signup agian",
      status: 405,
      user: savedUser,
    };
  } else {
    return {
      isSuccess: true,
      message: "User Sign Up Successfully.",
      status: 201,
      user: savedUser,
    };
  }
}

export async function sendConfirmationMailService(
  user_id: string,
  email: string,
  req: Request
) {
  const payload = { userId: user_id };
  const secretKey = process.env.EMAIL_TOKEN;
  const token = jwtSign(payload, secretKey, {
    algorithm: "HS256",
    expiresIn: "30d",
  });

  // send Email
  const parameters = {'{{url}}': `${req.protocol}://${req.headers.host}/api/v1/auth/confirmEmail/${token}`}
  const message = await readTemplate('activateEmail.template.html', parameters);

  sendEmail(email, "Confirm Your Account.", message, user_id);
}

export async function loginService(
  email: string,
  password: string,
  rememberMe: boolean
) {
  let user = await User.findOne({ email });
  if (!user) {
    return {
      isSuccess: false,
      message: "In-vaild Email OR Password.",
      status: 404,
    };
  } else {
    if (!user.confirm_email) {
      return {
        isSuccess: false,
        message: "Please confirm your Email first.",
        status: 400,
      };
    } else {
      if (user.isBlocked) {
        return {
          isSuccess: false,
          message: "Your acccount has bloced by Admin.",
          status: 400,
        };
      } else {
        if (user.authByThirdParty) {
          return {
            isSuccess: false,
            message:
              "You Can't Login From This Page. Please Reset Your Password. Thanks For Your Time.",
            status: 400,
          };
        } else {
          const match = await user.checkPasswordIsValid(password);
          if (!match) {
            return await lockUserLogin(user);
          } else {
            const result = await unlockLoginTimeFun(user);
            if (result.isSuccess === false) {
              return result;
            }
            user = result;

            // Check rememberMe
            let expiresIn = "24h";
            if (rememberMe) {
              expiresIn = "7d";
            }

            // Login Logic Use session Config flag With Not use Session By Default
            const SESSION_CONFIG =
              process.env.SESSION_CONFIG || "notUseSessionTable";

            if (SESSION_CONFIG == "useSessionTable") {
              const token_id = uuidv4();
              const resUserSessionToken = await createUserSession(
                token_id,
                user,
                expiresIn
              );

              if (resUserSessionToken == "Faild") {
                return {
                  isSuccess: false,
                  message:
                    "Oops, Occurred a problem While login. Please Try Login again.",
                  status: 401,
                };
              }

              return {
                isSuccess: true,
                message: "User Login Successfully.",
                status: 200,
                user: user,
                Token: resUserSessionToken,
              };
            } else if (SESSION_CONFIG == "notUseSessionTable") {
              const TokenJWT = await jwtSign(
                { id: user._id, role: user.role, permission: user.permission },
                process.env.TOKEN_SIGNATURE,
                { expiresIn }
              );

              return {
                isSuccess: true,
                message: "User Login Successfully.",
                status: 200,
                user: user,
                Token: TokenJWT,
              };
            }
          }
        }
      }
    }
  }
}
async function getKeyclaokAccessTokenByAuthCode(code: string) {
  const tokenUrl = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM_NAME}/protocol/openid-connect/token`;

  const response = await axios.post(
    tokenUrl,
    querystring.stringify({
      grant_type: "authorization_code",
      client_id: process.env.KEYCLOAK_CLIENT_ID,
      //   client_secret: keycloakConfig.clientSecret,
      redirect_uri: process.env.KEYCLOAK_REDIRICT_URL,
      code,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return response.data.access_token;
}
// New Explicit Keycloak
export async function callbackKeycloakURLService(code: string) {
  const access_token = await getKeyclaokAccessTokenByAuthCode(code);
  console.log(access_token);

  const public_key = `-----BEGIN PUBLIC KEY-----\n${process.env.KEYCLOAK_PUBLIC_KEY}\n-----END PUBLIC KEY-----`;

  const data = await jwtVerify(access_token, public_key, {
    algorithms: ["RS256"],
  });

  const token: string = await jwtSign(
    {
      id: data.sid,
      role: data.resource_access.account.roles,
      permission: [],
      keycloak_user_code: code,
    },
    process.env.TOKEN_SIGNATURE,
    { expiresIn: "7d" }
  );

  return {
    isSuccess: true,
    message: "Successful Authentication using Keycloak.",
    status: 200,
    userId: data.sid,
    token,
  };
}

export async function confirmEmailService(token: string) {
  const decoded = jwtVerify(token, process.env.EMAIL_TOKEN);

  if (!decoded) {
    return {
      isSuccess: false,
      message: "In-valid Token.",
      status: 403,
    };
  } else {
    const user = await User.findById(decoded.userId);

    if (!user) {
      return {
        isSuccess: false,
        message: "In-valid User ID.",
        status: 403,
      };
    } else {
      if (user.confirm_email) {
        return {
          isSuccess: false,
          message: "You already confirmed Please procced to login Pages.",
          status: 403,
        };
      } else {
        user.confirm_email = true;
        await user.save();

        return {
          isSuccess: true,
          message: "Done Please log In.",
          status: 200,
          user: user,
        };
      }
    }
  }
}

export async function resendConfirmEmailService(req: Request, userId: string) {
  const user = await User.findById(userId);

  if (!user) {
    return {
      isSuccess: false,
      message: "In-valid User ID Or This User is not exist.",
      status: 403,
    };
  } else {
    if (user.confirm_email) {
      return {
        isSuccess: false,
        message: "You already confirmed Please proceed to login Page.",
        status: 403,
      };
    } else {
      const payload = { userId: user._id };
      const secretKey = process.env.EMAIL_TOKEN;
      const token = jwtSign(payload, secretKey, {
        algorithm: "HS256",
        expiresIn: "30d",
        //issuer: 'your-issuer',
        //audience: 'your-audience',
      });

      // send Email
      const parameters = {'{{url}}': `${req.protocol}://${req.headers.host}/api/v1/auth/confirmEmail/${token}`}
      const message = await readTemplate('activateEmail.template.html', parameters);

      sendEmail(user.email, "Confirm Your Account.", message, user._id);

      return {
        isSuccess: true,
        message: "Check Your mail.",
        status: 200,
      };
    }
  }
}

export async function logoutService(userId: string, tokent_id: string) {
  let userLogOut = await User.findByIdAndUpdate(
    userId,
    {
      lastSeen: moment().format(),
    },
    { new: true }
  );

  if (!userLogOut) {
    return {
      isSuccess: false,
      message: "Sorry, Please try to Logout Again.",
      status: 401,
    };
  }
  // Check if using Session table to end session and deactive OR not

  if (process.env.SESSION_CONFIG == "useSessionTable") {
    // Close Session && Deactive Session
    const deactiveUserSession = await UserSession.findOneAndUpdate(
      { token_id: tokent_id, user_id: userId },
      {
        active: false,
        end_date: moment().format(),
      },
      { new: true }
    );

    if (!deactiveUserSession) {
      return {
        isSuccess: false,
        message: "Sorry, Please try to Logout agian.",
        status: 401,
      };
    } else {
      return {
        isSuccess: true,
        message: "User Logout Successfully.",
        status: 200,
        user: userLogOut,
      };
    }
  } else {
    return {
      isSuccess: true,
      message: "User Logout Successfully.",
      status: 200,
      user: userLogOut,
    };
  }
}

export async function generateResetPasswordLinkService(email: string) {
  const user = await User.findOne({ email });

  if (!user) {
    return {
      isSuccess: false,
      message: "User does not exist",
      status: 404,
    };
  }

  const token = await Token.findOne({ userId: user._id });
  if (token) await token.deleteOne();

  const resetToken = crypto.randomBytes(32).toString("hex");
  const hash = await bcrypt.hash(resetToken, Number(process.env.SALT_ROUND));
  await new Token({
    userId: user._id,
    token: hash,
  }).save();

  const link = `${process.env.CLIENT_URL}/resetPassword?token=${resetToken}&id=${user._id}`;

  return {
    isSuccess: true,
    message: "Check Your Mail To Reset Your Password.",
    status: 200,
    link: link,
    user_id: user._id,
  };
}

export async function resetPasswordService(
  userId: string,
  token: string,
  password: string
) {
  let passwordResetToken = await Token.findOne({ userId });

  if (!passwordResetToken) {
    return {
      isSuccess: false,
      message: "Invalid or expired password reset token.",
      status: 404,
    };
  }

  const isValid = await bcrypt.compare(token, passwordResetToken.token);

  if (!isValid) {
    return {
      isSuccess: false,
      message: "Invalid or expired password reset token.",
      status: 404,
    };
  }

  const hash = await bcrypt.hash(password, parseInt(process.env.SALT_ROUND));
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $set: { password: hash } },
    { new: true }
  );

  await passwordResetToken.deleteOne();

  return {
    isSuccess: true,
    message: "User Reset Password Successfully Check Your Mail.",
    status: 200,
    user: user,
  };
}

export async function createUserSession(
  token_id: string,
  user: UserInterface,
  expiresIn: string
): Promise<string> {
  const token: string = await jwtSign(
    {
      id: user._id,
      role: user.role,
      permission: user.permission,
      token_id: token_id,
    },
    process.env.TOKEN_SIGNATURE,
    { expiresIn }
  );

  const expire_date = calculateExpirationDate(expiresIn);

  const newUserSession = new UserSession({
    user_id: user._id,
    token_id: token_id,
    expire_date: expire_date,
  });
  const savedUserSession = await newUserSession.save();
  if (!savedUserSession) {
    return "Faild";
  } else {
    return token;
  }
}

async function lockUserLogin(user) {
  user.failedLoginAttempts++;
  await user.save();
  if (user.failedLoginAttempts >= Number(process.env.MAX_LOGIN_ATTEMPTS)) {
    if (user.unlockLoginTime && Date.now() > user.unlockLoginTime) {
      user.failedLoginAttempts = 1;
      user.unlockLoginTime = undefined;
      await user.save();
      return {
        isSuccess: false,
        message: "In-valid Email Or Password.",
        status: 400,
      };
    }

    if (!user.unlockLoginTime) {
      user.unlockLoginTime = calculateExpirationDate(process.env.LOCK_TIME);
      await user.save();
    }
    return {
      isSuccess: false,
      message: `Too many failed login attempts. Please try again after ${getRemaningMinutes(
        user.unlockLoginTime
      )} minutes.`,
      status: 401,
    };
  } else {
    return {
      isSuccess: false,
      message: "In-valid Email Or Password.",
      status: 400,
    };
  }
}

function getRemaningMinutes(userDate: number): number {
  return Math.floor((userDate - Date.now()) / (1000 * 60));
}

async function unlockLoginTimeFun(user) {
  if (user.unlockLoginTime && user.unlockLoginTime > Date.now()) {
    return {
      isSuccess: false,
      message: `Too many failed login attempts. Please try again after ${getRemaningMinutes(
        user.unlockLoginTime
      )} minutesss.`,
      status: 401,
    };
  } else {
    //if (user.unlockLoginTime && Date.now() > user.unlockLoginTime) {
    user.failedLoginAttempts = 0;
    user.unlockLoginTime = undefined;
    await user.save();
  }
  // else if (user.failedLoginAttempts) {
  //     user.failedLoginAttempts = 0;
  //     await user.save();
  // }

  return user;
}
